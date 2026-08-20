/*
 * Shared launch logic, used by both the popup and the keyboard command.
 *
 * The game is injected on demand rather than run as a permanent content script:
 * nothing touches a page until you actually ask for a ride, and `activeTab`
 * means the extension needs no standing host permissions.
 */
/* global chrome, browser */
var motoApi = (typeof browser !== 'undefined' && browser.scripting) ? browser : chrome;

var MOTO_FILES = ['content/physics.js', 'content/game.js'];

/*
 * Runs inside the page. Must be self-contained — it is serialised and injected,
 * so it cannot close over anything from this file.
 */
function motoStartInPage() {
  // globalThis, not window: in a Firefox content script the sandbox global and
  // the page's window are different objects, and the game lives in the former
  var g = globalThis;
  if (!g.MotoCharts) return { ok: false, candidates: 0, top: window.top === window };
  var n = 0, err = null;
  try { n = g.MotoCharts._collectPaths().length; } catch (e) { err = String(e); }
  if (n > 0) g.MotoCharts.start();
  return { ok: true, candidates: n, error: err, top: window.top === window };
}

function motoReportNothing() {
  var box = document.createElement('div');
  box.setAttribute('style',
    'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483600;' +
    'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:10px;' +
    'padding:12px 18px;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 30px #0009;max-width:520px');
  box.textContent = 'moto-charts: no chart lines found on this page. ' +
    'If the chart is inside a cross-origin iframe, open it in its own tab and try again.';
  document.body.appendChild(box);
  setTimeout(function () { box.remove(); }, 6000);
}

function motoAlreadyRunning() {
  return !!(globalThis.MotoCharts && globalThis.MotoCharts.current);
}

/* Returns a short status string for the popup. */
async function motoLaunch(tab) {
  if (!tab || tab.id == null) return 'no active tab';

  var target = { tabId: tab.id };
  try {
    await motoApi.scripting.executeScript({ target: target, files: MOTO_FILES });
    var res = await motoApi.scripting.executeScript({ target: target, func: motoStartInPage });
    var top = (res && res[0] && res[0].result) || { ok: false, candidates: 0 };
    if (top.candidates > 0) return 'riding: ' + top.candidates + ' line(s) found';
    // a failed load and an empty page look identical from here unless we say so
    if (top.ok === false) return 'the game script did not load into the page';
    if (top.error) return 'line discovery failed: ' + top.error;

    // Nothing in the top document — the chart may live in an iframe. Same-origin
    // frames are already covered by the picker itself, so reaching this point
    // means trying every frame we are allowed to touch.
    var allFrames = { tabId: tab.id, allFrames: true };
    await motoApi.scripting.executeScript({ target: allFrames, files: MOTO_FILES });
    var res2 = await motoApi.scripting.executeScript({ target: allFrames, func: motoStartInPage });
    var total = (res2 || []).reduce(function (acc, r) {
      return acc + ((r && r.result && r.result.candidates) || 0);
    }, 0);
    if (total > 0) return 'riding inside a frame: ' + total + ' line(s)';

    await motoApi.scripting.executeScript({ target: target, func: motoReportNothing });
    return 'no chart lines found';
  } catch (e) {
    return 'the page refused injection: ' + (e && e.message ? e.message : e);
  }
}

/* Lists what the extractor sees, without starting a ride. */
async function motoDiagnose(tab) {
  if (!tab || tab.id == null) return [];
  try {
    await motoApi.scripting.executeScript({ target: { tabId: tab.id }, files: MOTO_FILES });
    var res = await motoApi.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function () {
        if (!globalThis.MotoCharts) return [{ tag: 'game script did not load', width: 0, color: '#f97583' }];
        try {
          return globalThis.MotoCharts._collectPaths().map(function (c) {
            return {
              tag: c.el.tagName + (c.el.id ? '#' + c.el.id : ''),
              width: Math.round(c.width),
              color: c.color,
              top: window.top === window
            };
          });
        } catch (e) { return []; }
      }
    });
    return (res || []).flatMap(function (r) { return (r && r.result) || []; });
  } catch (e) {
    return [{ tag: 'error: ' + (e && e.message ? e.message : e), width: 0, color: '#f97583' }];
  }
}
