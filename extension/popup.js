/* global motoApi, motoLaunch, motoDiagnose */
(function () {
  'use strict';

  var status = document.getElementById('status');
  var list = document.getElementById('list');

  async function activeTab() {
    var tabs = await motoApi.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  document.getElementById('go').addEventListener('click', async function () {
    status.textContent = 'starting…';
    var msg = await motoLaunch(await activeTab());
    status.textContent = msg;
    // the game takes over the page, so the popup has nothing left to show
    if (msg.indexOf('riding') === 0) window.close();
  });

  document.getElementById('diag').addEventListener('click', async function () {
    status.textContent = 'scanning the page…';
    list.textContent = '';
    var found = await motoDiagnose(await activeTab());
    status.textContent = 'track candidates: ' + found.length;
    found.slice(0, 12).forEach(function (c) {
      var row = document.createElement('div');
      var sw = document.createElement('i');
      sw.className = 'sw';
      sw.style.background = c.color || '#7ee787';
      row.appendChild(sw);
      row.appendChild(document.createTextNode(
        c.tag + ' · ' + c.width + 'px' + (c.top === false ? ' · iframe' : '')));
      list.appendChild(row);
    });
    if (found.length > 12) {
      var more = document.createElement('div');
      more.textContent = '… and ' + (found.length - 12) + ' more';
      list.appendChild(more);
    }
  });
})();
