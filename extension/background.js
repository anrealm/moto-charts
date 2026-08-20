/*
 * Only job: turn the keyboard command into a ride. Chrome runs this as a
 * service worker (hence importScripts), Firefox as a background script with
 * launcher.js already listed ahead of it in the manifest.
 */
/* global importScripts, motoApi, motoLaunch */
if (typeof importScripts === 'function') importScripts('launcher.js');

motoApi.commands.onCommand.addListener(async function (command) {
  if (command !== 'start-ride') return;
  var tabs = await motoApi.tabs.query({ active: true, currentWindow: true });
  await motoLaunch(tabs && tabs[0]);
});
