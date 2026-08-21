/* Popup: quick toggles plus a live status line for the active tab. */
(() => {
  'use strict';

  const { get, set } = globalThis.YD.settings;
  const $ = (id) => document.getElementById(id);

  const activeTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  };

  const isYouTubeWatch = (tab) =>
    !!tab &&
    typeof tab.url === 'string' &&
    /^https:\/\/(www|m)\.youtube\.com\/(watch\?|shorts\/)/.test(tab.url);

  const init = async () => {
    const settings = await get();
    $('translator').value = settings.translator;
    $('ttsEngine').value = settings.ttsEngine;

    const tab = await activeTab();
    const onVideo = isYouTubeWatch(tab);

    $('status').textContent = onVideo
      ? 'یک ویدیوی یوتیوب باز است. برای شروع دکمه زیر یا پنل روی پلیر را بزنید.'
      : 'یک ویدیوی یوتیوب باز کنید تا دوبله فعال شود.';
    $('toggle').disabled = !onVideo;
    $('toggle').style.opacity = onVideo ? '1' : '.5';

    $('toggle').addEventListener('click', async () => {
      if (!tab) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'command', payload: 'toggle' });
        window.close();
      } catch (_) {
        $('status').textContent =
          'ارتباط با صفحه برقرار نشد. صفحه یوتیوب را یک بار تازه‌سازی کنید.';
      }
    });

    ['translator', 'ttsEngine'].forEach((id) =>
      $(id).addEventListener('change', () => set({ [id]: $(id).value }))
    );

    $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  };

  init();
})();
