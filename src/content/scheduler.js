/**
 * The sync engine.
 *
 * Persian takes roughly 20-30% longer to say than the English it came from, so
 * something has to give. This runs the timeline with four mechanisms, in order
 * of how noticeable they are, and only reaches for the next one when the
 * previous has run out:
 *
 *   1. planning     -- `planner.js` places every sentence over the whole
 *                      timeline at once, so a dense passage is compressed
 *                      gradually instead of one sentence being crushed
 *   2. measurement  -- Piper and Gemini render ahead and report the exact
 *                      length of each sentence, so placement is not a guess;
 *                      the browser voice cannot, so its speed is learned
 *   3. rate         -- each sentence is spoken slightly faster if it needs to
 *                      be, up to a ceiling past which speech stops being clear
 *   4. easing       -- whatever still does not fit is paid for by slowing the
 *                      picture a few percent for the length of the sentence
 *
 * The picture is never frozen. Easing is continuous and, at the default floor,
 * far less intrusive than a stop; anything it cannot absorb becomes a small
 * lag that the next pause in speech soaks up on its own, because the planner
 * always pulls sentences back towards their caption time.
 *
 * The engine owns nothing on the page except the video's volume and playback
 * rate, and restores both on stop.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.scheduler) return;

  const { clamp, lastIndexBefore, log } = YD.util;

  const TICK_MS = 25; // start times land within a frame or two
  const RESUME_SLACK = 0.25; // a cue that just began still counts as upcoming
  const ABANDON_AFTER = 3.0; // give up on a sentence this far behind
  const REPLAN_EPSILON = 0.05; // relative error that justifies replanning
  const MEASURE_AHEAD = 12; // sentences rendered ahead of the playhead
  const RATE_RERENDER = 0.04; // re-render if the planned rate moved this much

  const create = ({ video, cues, engine, settings, onEvent = () => {} }) => {
    /* ------------------------------------------------------------------ *
     * Durations and plan
     * ------------------------------------------------------------------ */

    // Let the engine see the whole script, so one that can render a passage
    // in a single request knows what surrounds each sentence.
    if (typeof engine.setScript === 'function') {
      engine.setScript(settings.groupSentences > 1 ? cues : null, {
        groupSize: settings.groupSentences,
        maxGap: settings.groupMaxGap,
      });
    }

    const natural = cues.map((cue) =>
      YD.planner.estimateDuration(cue.text, settings.charsPerSecond)
    );
    const measuredAt = new Array(cues.length).fill(0); // rate each was rendered at
    let plan = YD.planner.build(cues, natural, settings, {
      mediaDuration: video.duration,
    });

    const replan = (fromIndex, prevEnd) => {
      plan = YD.planner.build(
        cues,
        natural,
        { ...settings, playbackScale: userRate },
        { fromIndex, prevEnd, mediaDuration: video.duration }
      );
      onEvent({ type: 'replan', stats: YD.planner.summarise(plan, settings) });
    };

    /* ---------------------------- state ----------------------------- */

    let running = false;
    let timer = null;
    let cursor = 0;
    let active = null;
    let preparing = false;

    let userVolume = video.volume;
    let ducked = false;
    let volumeRamp = null;
    let applyingVolume = false;

    let userRate = video.playbackRate || 1;
    let applyingRate = false;
    let easing = 1;

    let selfPaused = false; // only used by the legacy 'pause' policy
    let holdTimer = null;

    /* ------------------------------------------------------------------ *
     * Measuring ahead
     *
     * Rendering a sentence before it is needed (locally with Piper or remotely
     * with Gemini) replaces the
     * characters-per-second guess with the real number, which is where most
     * of the precision comes from.
     * ------------------------------------------------------------------ */

    const measureAhead = async () => {
      if (preparing || typeof engine.prepare !== 'function') return;
      preparing = true;
      try {
        const until = Math.min(cues.length, cursor + MEASURE_AHEAD);
        for (let i = cursor; i < until; i++) {
          if (!running) return;
          const entry = plan[i];
          if (!entry || entry.dropped) continue; // never spoken, never rendered

          // Already rendered at essentially this rate: nothing to learn.
          if (measuredAt[i] && Math.abs(measuredAt[i] - entry.rate) < RATE_RERENDER) {
            continue;
          }

          const duration = await engine.prepare(entry.text, {
            rate: entry.rate,
            cueIndex: i,
          });
          if (!running) return;
          if (!duration) {
            // Engine cannot measure ahead; stop asking.
            if (!engine.exact) return;
            continue;
          }

          const observed = duration * entry.rate; // back out to rate 1
          const changed = Math.abs(observed - natural[i]) / Math.max(0.2, natural[i]);
          natural[i] = observed;
          measuredAt[i] = entry.rate;

          if (changed > REPLAN_EPSILON) {
            replan(activeIndexFloor(), activeEnd());
          }
        }
      } finally {
        preparing = false;
      }
    };

    /** Index the plan may be rewritten from without disturbing live speech. */
    const activeIndexFloor = () => (active ? active.entry.index + 1 : cursor);

    /** Video time at which speech currently in flight is expected to stop. */
    const activeEnd = () => {
      if (!active) return video.currentTime;
      // While easing, the picture advances more slowly than the wall clock, so
      // the sentence covers proportionally less of the timeline.
      return active.startedAtVideoTime + active.entry.videoDuration * easing;
    };

    /**
     * Fold the browser voice's learned speaking rate back into the estimates.
     * Only cues that have never been measured are affected.
     */
    const applyCalibration = () => {
      if (typeof engine.calibration !== 'function') return;
      const calibration = engine.calibration();
      if (!calibration || !calibration.charsPerSecond) return;

      const cps = calibration.charsPerSecond;
      if (Math.abs(cps - settings.charsPerSecond) / settings.charsPerSecond < 0.03) return;

      settings = { ...settings, charsPerSecond: cps };
      for (let i = 0; i < cues.length; i++) {
        if (measuredAt[i]) continue;
        natural[i] = YD.planner.estimateDuration(cues[i].text, cps);
      }
      log('recalibrated to', cps.toFixed(1), 'chars/sec');
      replan(activeIndexFloor(), activeEnd());
    };

    /* ---------------------------- volume ---------------------------- */

    const setVolume = (value) => {
      applyingVolume = true;
      try {
        video.volume = clamp(value, 0, 1);
      } finally {
        setTimeout(() => {
          applyingVolume = false;
        }, 0);
      }
    };

    /**
     * Ducking is deliberately asymmetric.
     *
     * A symmetric ramp is the wrong shape for speech in both directions. Going
     * down, the original has to be out of the way *before* the first syllable
     * lands, or the start of the sentence fights it -- so the attack is quick.
     * Coming back up, a quick ramp is exactly what makes a dub sound like an
     * effect being switched on and off, and it also pumps audibly through the
     * short gaps between sentences; a slow release rides through those gaps
     * and reads as the original simply being present again.
     */
    const rampVolume = (target, ms) => {
      if (volumeRamp) {
        clearInterval(volumeRamp);
        volumeRamp = null;
      }
      const from = video.volume;
      const duration = Math.max(0, ms);
      if (duration < 20 || Math.abs(target - from) < 0.01) {
        setVolume(target);
        return;
      }
      const started = performance.now();
      volumeRamp = setInterval(() => {
        const p = clamp((performance.now() - started) / duration, 0, 1);
        // Equal-power-ish curve: a linear ramp on a level control sounds like
        // it does most of its work at the very end.
        const shaped = p * p * (3 - 2 * p);
        setVolume(from + (target - from) * shaped);
        if (p >= 1) {
          clearInterval(volumeRamp);
          volumeRamp = null;
        }
      }, 16);
    };

    const duck = () => {
      if (ducked) return;
      ducked = true;
      rampVolume(userVolume * settings.duckVolume, settings.duckAttackMs);
    };

    const unduck = () => {
      if (!ducked) return;
      ducked = false;
      rampVolume(userVolume, settings.duckReleaseMs);
    };

    /**
     * Un-duck only if the original has time to be worth hearing.
     *
     * Between two sentences of a dense passage there is often less than a
     * second of gap. Restoring the original across it and pulling it straight
     * back down is the classic pumping artefact -- and there is nothing under
     * the gap worth restoring for anyway. Holding the duck through short gaps
     * is what makes a dub sit *in* the mix instead of on top of it.
     */
    const unduckIfGapAllows = () => {
      const next = plan[cursor];
      if (next && !next.dropped) {
        const gap = (next.at - video.currentTime) / Math.max(0.1, userRate * easing);
        if (gap < settings.duckHoldSeconds) return;
      }
      unduck();
    };

    const onVolumeChange = () => {
      if (applyingVolume || ducked) return;
      userVolume = video.volume;
    };

    /* -------------------------- playback rate ------------------------ */

    const setEasing = (factor) => {
      const next = clamp(factor, settings.minPlaybackRate, 1);
      if (Math.abs(next - easing) < 0.005) return;
      easing = next;

      applyingRate = true;
      try {
        // Keep the viewer's own speed choice intact: easing multiplies it.
        video.playbackRate = clamp(userRate * easing, 0.0625, 16);
        video.preservesPitch = true;
      } catch (_) {
        /* some builds refuse extreme rates */
      } finally {
        setTimeout(() => {
          applyingRate = false;
        }, 0);
      }
      onEvent({ type: 'easing', factor: easing });
    };

    const onRateChange = () => {
      if (applyingRate) return;
      // The viewer moved the speed control; treat that as the new baseline.
      const next = video.playbackRate / (easing || 1);
      if (Math.abs(next - userRate) < 0.01) return;
      userRate = next;
      // Every duration in the plan was expressed against the old speed, so the
      // whole timeline has to be rebuilt around the new one.
      replan(activeIndexFloor(), activeEnd());
      log('viewer changed speed to', userRate.toFixed(2));
    };

    /* --------------------------- speaking --------------------------- */

    const prefetchAhead = (from) => {
      if (typeof engine.prefetch !== 'function') return;
      for (let i = from; i < Math.min(from + 3, plan.length); i++) {
        if (plan[i]) engine.prefetch(plan[i].text, { rate: plan[i].rate, cueIndex: i });
      }
    };

    const startCue = (entry) => {
      const handle = engine.speak(entry.text, {
        rate: entry.rate,
        pitch: settings.pitch,
        lang: `${settings.targetLang}-IR`,
        // Lets a grouped engine find the passage this sentence belongs to.
        cueIndex: entry.index,
      });

      active = {
        entry,
        handle,
        startedAtWall: performance.now(),
        startedAtVideoTime: video.currentTime,
        held: false,
      };

      duck();
      setEasing(YD.planner.videoRateFor(entry, settings));
      onEvent({ type: 'cue', cue: entry, lag: entry.lag });
      prefetchAhead(entry.index + 1);
      measureAhead();

      handle.promise.then(() => {
        if (!active || active.handle !== handle) return;

        const wall = (performance.now() - active.startedAtWall) / 1000;
        const overran = wall - entry.duration;
        active = null;

        unduckIfGapAllows();
        setEasing(1);
        releaseVideo();
        applyCalibration();

        // Speech finished away from where it was planned to: rebuild the rest
        // of the timeline from here so the error does not accumulate.
        if (Math.abs(overran) > 0.15) {
          replan(cursor, video.currentTime);
        }
        onEvent({ type: 'cueEnd', cue: entry, overran });
      });
    };

    const stopSpeaking = () => {
      if (active) {
        active.handle.cancel();
        active = null;
      }
      engine.cancelAll();
      unduck();
      setEasing(1);
      releaseVideo();
    };

    /* ------------------- legacy 'pause' policy only ------------------ */

    const holdVideo = () => {
      if (selfPaused || video.paused) return;
      if (!active || active.held) return;
      active.held = true;

      selfPaused = true;
      video.pause();
      onEvent({ type: 'hold', on: true });
      holdTimer = setTimeout(releaseVideo, settings.pauseMaxSeconds * 1000);
    };

    const releaseVideo = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (!selfPaused) return;
      selfPaused = false;
      onEvent({ type: 'hold', on: false });
      video.play().catch(() => {});
    };

    const adPlaying = () => {
      const player = document.getElementById('movie_player');
      return !!(player && player.classList.contains('ad-showing'));
    };

    /* ----------------------------- tick ----------------------------- */

    const tick = () => {
      if (!running) return;

      if (adPlaying()) {
        if (active) stopSpeaking();
        return;
      }

      const t = video.currentTime;

      if (active) {
        if (settings.overrunPolicy === 'pause' && !video.paused && t >= active.entry.deadline - 0.02) {
          holdVideo();
        }
        return;
      }

      if (video.paused) return;

      // Skip what the planner already gave up on, plus anything a stall or a
      // slow render has pushed too far past its moment to still be worth
      // saying -- it would land on top of a sentence that has moved on.
      while (
        cursor < plan.length &&
        (plan[cursor].dropped || t - plan[cursor].start > ABANDON_AFTER)
      ) {
        onEvent({ type: 'dropped', cue: plan[cursor] });
        cursor++;
      }

      if (cursor < plan.length && t >= plan[cursor].at) {
        const entry = plan[cursor];
        cursor++;
        startCue(entry);
      }
    };

    /* --------------------------- listeners -------------------------- */

    const onSeeking = () => {
      stopSpeaking();
      cursor = Math.max(0, lastIndexBefore(plan, video.currentTime - RESUME_SLACK) + 1);
      replan(cursor, video.currentTime);
      measureAhead();
      onEvent({ type: 'seek', index: cursor });
    };

    const onPause = () => {
      if (selfPaused) return;
      engine.pause();
    };

    const onPlay = () => {
      if (selfPaused) return;
      engine.resume();
    };

    const onEnded = () => stopSpeaking();

    /* ---------------------------- control --------------------------- */

    const start = () => {
      if (running) return;
      running = true;

      userVolume = video.volume;
      userRate = video.playbackRate || 1;
      easing = 1;

      cursor = Math.max(0, lastIndexBefore(plan, video.currentTime - RESUME_SLACK) + 1);
      replan(cursor, video.currentTime);

      video.addEventListener('seeking', onSeeking);
      video.addEventListener('pause', onPause);
      video.addEventListener('play', onPlay);
      video.addEventListener('ended', onEnded);
      video.addEventListener('volumechange', onVolumeChange);
      video.addEventListener('ratechange', onRateChange);

      timer = setInterval(tick, TICK_MS);
      video.addEventListener('timeupdate', tick);

      prefetchAhead(cursor);
      measureAhead();
      onEvent({ type: 'started', stats: YD.planner.summarise(plan, settings) });
    };

    const stop = () => {
      if (!running) return;
      running = false;

      if (timer) clearInterval(timer);
      timer = null;

      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('timeupdate', tick);

      stopSpeaking();

      if (volumeRamp) {
        clearInterval(volumeRamp);
        volumeRamp = null;
      }
      setVolume(userVolume);

      applyingRate = true;
      try {
        video.playbackRate = userRate;
      } catch (_) {
        /* ignore */
      }
      applyingRate = false;
      easing = 1;

      onEvent({ type: 'stopped' });
    };

    return {
      start,
      stop,
      get running() {
        return running;
      },
      get stats() {
        return { ...YD.planner.summarise(plan, settings), cursor };
      },
      get plan() {
        return plan;
      },
    };
  };

  YD.scheduler = { create };
})();
