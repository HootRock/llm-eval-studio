/* ============================================================================
   分段按钮（.seg）的公共行为。
   放在共享文件里 —— 之前它写在已删除的 app.js 中，
   而 run.html / preview.html 仍在监听 segchange，导致按钮点了没反应。

   用法：给容器加 class="seg" 与 data-group="xxx"，
   页面监听 document 上的 segchange 事件（detail 为 { group, value }）。
   ============================================================================ */
(function (global) {
  'use strict';

  function initSegs(root) {
    (root || document).querySelectorAll('.seg').forEach(function (seg) {
      if (seg.getAttribute('data-seg-ready')) return;
      seg.setAttribute('data-seg-ready', '1');

      var btns = Array.prototype.slice.call(seg.querySelectorAll('button'));
      btns.forEach(function (b) {
        // 若 HTML 未标初始选中项，默认选中第一个
        b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
      });
      if (!btns.some(function (b) { return b.classList.contains('on'); }) && btns[0]) {
        btns[0].classList.add('on');
        btns[0].setAttribute('aria-pressed', 'true');
      }

      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b || !seg.contains(b) || b.classList.contains('on')) return;
        btns.forEach(function (x) {
          x.classList.remove('on');
          x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('on');
        b.setAttribute('aria-pressed', 'true');
        document.dispatchEvent(new CustomEvent('segchange', {
          detail: {
            group: seg.getAttribute('data-group') || '',
            value: b.getAttribute('data-value') || ''
          }
        }));
      });
    });
  }

  global.Seg = { init: initSegs };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initSegs(); });
  } else {
    initSegs();
  }
})(window);
