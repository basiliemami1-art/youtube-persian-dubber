/**
 * Timeline planner.
 *
 * Decides, for every sentence, *when* to start speaking it and *how fast*.
 *
 * The naive approach -- look at one cue, see it does not fit, speed it up --
 * fails on dense passages: cue 5 gets crushed to the rate ceiling while cues
 * 1-4 sat at normal speed with slack they never used. So planning happens over
 * the whole timeline in two passes:
 *
 *   backward  what is the latest each cue may *finish*, given everything that
 *             follows it still has to fit? A dense stretch ahead propagates
 *             pressure backwards, so compression starts early and is shared.
 *
 *   forward   walk the timeline, start each cue as close to its caption time
 *             as the previous one allows, and pick the gentlest rate that
 *             meets the deadline the backward pass computed.
 *
 * Two tolerances make this work at all. A cue may start slightly early
 * (`maxLead`) and slightly late (`maxLag`); real speech has that much give,
 * and those few hundred milliseconds are what let a long sentence borrow room
 * from the pause around it instead of being sped up.
 *
 * Whatever still does not fit comes back as `overflow` -- seconds the
 * scheduler has to find elsewhere, by easing the video down rather than
 * freezing it.
 *
 * Pure functions only: no DOM, no timers. Everything here is testable.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.planner) return;

  const { clamp, spokenLength } = YD.util;

  const TAIL_ROOM = 6.0; // assumed silence after the final cue

  /** Natural duration (seconds at rate 1) when nothing has measured it yet. */
  const estimateDuration = (text, charsPerSecond) =>
    Math.max(0.25, spokenLength(text) / Math.max(1, charsPerSecond));

  /**
   * @param {Array<{start:number,end:number,text:string}>} cues
   * @param {number[]} natural  per-cue duration in seconds at rate 1
   * @param {Object} settings
   * @param {{fromIndex?:number, prevEnd?:number, mediaDuration?:number}} [seed]
   *        `prevEnd` is the video time at which speech already in flight will
   *        stop, so a mid-playback replan does not plan over itself.
   * @returns {Array} plan entries
   */
  const build = (cues, natural, settings, seed = {}) => {
    const count = cues.length;
    if (!count) return [];

    const baseRate = settings.baseRate;
    const minRate = Math.min(settings.minRate, baseRate);
    const maxRate = Math.max(settings.maxRate, baseRate);
    const maxLead = Math.max(0, settings.maxLead);
    const maxLag = Math.max(0, settings.maxLag);

    const from = clamp(seed.fromIndex || 0, 0, count);

    // Speech takes wall-clock seconds; the timeline is measured in video
    // seconds. They are only the same thing at 1x. If the viewer is watching
    // at 1.25x, every sentence eats 1.25 video-seconds per second of speech,
    // and ignoring that would make the whole plan quietly wrong.
    const scale = Math.max(0.25, settings.playbackScale || 1);
    const horizonEnd =
      (seed.mediaDuration || cues[count - 1].end || cues[count - 1].start) + TAIL_ROOM;

    /* ---------------------------------------------------------------- *
     * Backward pass: the latest video time each cue may finish speaking.
     * ---------------------------------------------------------------- */

    const finishBy = new Array(count);
    finishBy[count - 1] = horizonEnd;

    for (let i = count - 2; i >= 0; i--) {
      const next = cues[i + 1];
      // Cue i must be done before cue i+1 starts -- and cue i+1 is allowed to
      // begin a little late.
      const byNextStart = next.start + maxLag;
      // ...but cue i+1 also has its own deadline, and even at full speed it
      // needs this much time, so cue i must clear the way earlier still.
      const byChain = finishBy[i + 1] - (natural[i + 1] / maxRate) * scale;
      finishBy[i] = Math.min(byNextStart, byChain);
    }

    /* ---------------------------------------------------------------- *
     * Forward pass: actual start times and rates.
     * ---------------------------------------------------------------- */

    const plan = new Array(count);
    let prevEnd = Number.isFinite(seed.prevEnd) ? seed.prevEnd : -Infinity;

    for (let i = from; i < count; i++) {
      const cue = cues[i];

      // Start as close to the caption as possible: no earlier than the lead
      // allowance, and never before the previous sentence has finished.
      const earliest = cue.start - maxLead;
      const at = Math.max(earliest, prevEnd);
      const lag = at - cue.start;

      // Some passages simply cannot be dubbed in the time available -- speech
      // that dense outruns both the rate ceiling and the easing floor, and the
      // backlog then grows without limit. Once a sentence would land this far
      // from the moment it belongs to, it is worth less than the damage it
      // does: saying it would push every later sentence further out of sync
      // too. Skip it, leave `prevEnd` where it is, and the timeline walks back
      // into alignment within a sentence or two.
      if (lag > settings.maxDrift) {
        plan[i] = {
          index: i,
          start: cue.start,
          text: cue.text,
          display: cue.display || cue.text,
          at,
          lag,
          rate: baseRate,
          duration: 0,
          natural: natural[i],
          deadline: finishBy[i],
          budget: 0,
          overflow: 0,
          dropped: true,
        };
        continue; // prevEnd deliberately unchanged
      }

      const budget = Math.max(0.2, finishBy[i] - at);

      // Meeting the deadline is not enough. A sentence that merely fits leaves
      // the lag it inherited untouched, so the dub settles at the lag ceiling
      // and stays there for the whole dense passage -- audibly behind the
      // English. Aim to finish early in proportion to how late we already are,
      // so each sentence gives back part of the delay and the dub walks itself
      // back into sync instead of waiting for the next silence.
      const catchUp = Math.max(0, lag) * settings.lagRecovery;
      const target = Math.max(0.2, budget - catchUp);

      const needed = (natural[i] * scale) / target;
      const rate = clamp(Math.max(needed, baseRate), minRate, maxRate);

      const duration = natural[i] / rate; // wall-clock seconds of speech
      const videoDuration = duration * scale; // the same span, in video time

      // What the rate ceiling could not absorb. The scheduler pays this by
      // easing the video down over the sentence.
      const overflow = Math.max(0, videoDuration - budget);

      plan[i] = {
        index: i,
        start: cue.start,
        text: cue.text,
        display: cue.display || cue.text,
        at,
        lag,
        rate,
        duration,
        videoDuration,
        natural: natural[i],
        deadline: finishBy[i],
        budget,
        overflow,
      };

      prevEnd = at + videoDuration;
    }

    return plan;
  };

  /**
   * How much to slow the picture so a sentence lands on time.
   *
   * Returns a multiplier for the video's normal speed: 1 means untouched.
   * Only ever slows down -- speeding the video up to catch up would be far
   * more noticeable than the dub running a little long.
   */
  const videoRateFor = (entry, settings) => {
    if (!entry || entry.overflow <= 0.01 || entry.dropped) return 1;
    if (settings.overrunPolicy !== 'stretch') return 1;

    // The picture must cover `budget` seconds of timeline in the span the
    // voice needs. Both sides are already in video time, so this is the exact
    // multiplier -- and it stays correct whatever speed the viewer has set.
    const needed = entry.budget / Math.max(0.01, entry.videoDuration);
    return clamp(needed, settings.minPlaybackRate, 1);
  };

  /**
   * Summary used for the status line and for tests.
   */
  const summarise = (plan, settings) => {
    let stretched = 0;
    let late = 0;
    let dropped = 0;
    let worstLag = 0;
    let slowest = 1;

    for (const entry of plan) {
      if (!entry) continue;
      if (entry.dropped) {
        dropped++;
        continue; // a skipped sentence is not "late", it is simply absent
      }
      if (entry.overflow > 0.01) stretched++;
      if (entry.lag > 0.05) {
        late++;
        worstLag = Math.max(worstLag, entry.lag);
      }
      slowest = Math.min(slowest, videoRateFor(entry, settings));
    }

    return { total: plan.length, stretched, late, dropped, worstLag, slowest };
  };

  YD.planner = { build, estimateDuration, videoRateFor, summarise, TAIL_ROOM };
})();
