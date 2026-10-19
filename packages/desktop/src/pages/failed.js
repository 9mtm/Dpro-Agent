'use strict';
const params = new URLSearchParams(window.location.search);
document.getElementById('reason').textContent = params.get('reason') || 'Unknown problem.';
if (params.get('remote') === '1') {
  document.getElementById('title').textContent = 'Dpro Agent could not be reached';
  document.getElementById('local').hidden = false;
}
document.getElementById('retry').addEventListener('click', () => window.dproDesktop.retry());
document.getElementById('connect').addEventListener('click', () => window.dproDesktop.openConnect());
document.getElementById('local').addEventListener('click', () => window.dproDesktop.useLocal());
