/* ============================================================================
   结果可视化。全部用 DOM + CSS 动画，不引入图表库。

     renderTrace   —— 工具调用的逐步执行轨迹（带分叉：在哪一环断的）
     playTrace     —— 轨迹动画播放
     renderLeak    —— 信息泄露对比（泄露了哪些、多少）
     renderHalluFlow —— 幻觉四步判定的漏斗

   所有文本均以 textContent 写入，不拼接 HTML。
   ============================================================================ */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pct(v, d) { return (v * 100).toFixed(d == null ? 2 : d) + '%'; }

  /* ==================================================================
     工具调用轨迹。
     主干为步骤序列；一旦某步失败，其后步骤标记为「未到达」，
     并在失败步上拉出一条分叉线，直观说明断点在哪里。
     ================================================================== */
  function renderTrace(host, row) {
    host.textContent = '';
    var steps = row.steps || [];

    var wrap = el('div', 'trace-v');
    var spine = el('div', 'tv-spine');

    // 第一个未通过的步骤即断点
    var failIdx = -1;
    for (var k = 0; k < steps.length; k++) { if (!steps[k].ok) { failIdx = k; break; } }

    steps.forEach(function (s, i) {
      var node = el('div', 'tv-node' + (s.ok ? ' ok' : ' fail'));

      var rail = el('div', 'tv-rail');
      var dot = el('div', 'tv-dot');
      rail.appendChild(dot);
      if (i < steps.length - 1) rail.appendChild(el('div', 'tv-line'));
      node.appendChild(rail);

      var body = el('div', 'tv-body');
      var head = el('div', 'tv-head');
      head.appendChild(el('span', 'tv-name', s.name));
      head.appendChild(el('span', 'tv-badge' + (s.ok ? ' ok' : ' fail'),
        s.ok ? '通过' : '未通过'));
      body.appendChild(head);

      if (s.note) body.appendChild(el('div', 'tv-note', s.note));

      // 参数字段的逐项对比：缺哪个字段直接列出来
      if (s.data && (s.data.missing || s.data.wrongVal || s.data.extra)) {
        if (s.data.missing && s.data.missing.length) {
          var m = el('div', 'tv-fields');
          m.appendChild(el('span', 'tv-fk', '缺字段'));
          s.data.missing.forEach(function (key) {
            m.appendChild(el('span', 'tv-chip miss', key));
          });
          body.appendChild(m);
        }
        if (s.data.wrongVal && s.data.wrongVal.length) {
          var w = el('div', 'tv-fields');
          w.appendChild(el('span', 'tv-fk', '值不符'));
          s.data.wrongVal.forEach(function (x) {
            w.appendChild(el('span', 'tv-chip wrong',
              x.key + '：得 ' + JSON.stringify(x.got) + '，应为 ' + JSON.stringify(x.want)));
          });
          body.appendChild(w);
        }
        if (s.data.extra && s.data.extra.length) {
          var e2 = el('div', 'tv-fields');
          e2.appendChild(el('span', 'tv-fk', '多余'));
          s.data.extra.forEach(function (key) {
            e2.appendChild(el('span', 'tv-chip extra', key));
          });
          body.appendChild(e2);
        }
      }

      /* 分叉直接挂在断点那一步的正文里，不用绝对定位。
         之前按固定行高估算偏移量，遇到带字段标签（高度不同）的步骤
         就会错位 —— 内联渲染与高度无关，稳定。 */
      if (i === failIdx && failIdx < steps.length - 1) {
        var fork = el('div', 'tv-fork-inline');
        var stem = el('div', 'tv-fork-stem');
        var lab = el('div', 'tv-fork-label');
        lab.appendChild(el('b', null, '分叉点'));
        lab.appendChild(el('span', null,
          '「' + s.name + '」未通过，后续 ' +
          (steps.length - failIdx - 1) + ' 个步骤未执行'));
        fork.appendChild(stem);
        fork.appendChild(lab);
        body.appendChild(fork);
      }

      node.appendChild(body);
      spine.appendChild(node);
    });

    wrap.appendChild(spine);
    host.appendChild(wrap);
  }

  // 逐个点亮，像逐步执行
  function playTrace(host, speed) {
    var nodes = host.querySelectorAll('.tv-node');
    var delay = speed || 260;
    nodes.forEach(function (n) { n.classList.remove('shown'); });
    nodes.forEach(function (n, i) {
      setTimeout(function () { n.classList.add('shown'); }, i * delay);
    });
    return nodes.length * delay;
  }

  /* ==================================================================
     信息泄露对比：泄露条数 + 逐条实体。
     实体值做遮蔽处理（只显示首尾），数据集为保密内容。
     ================================================================== */
  function mask(v) {
    var s = String(v);
    if (s.length <= 4) return s[0] + '***';
    return s.slice(0, 3) + '***' + s.slice(-3);
  }

  function renderLeak(host, row) {
    host.textContent = '';

    var summary = el('div', 'leak-sum');
    var bar = el('div', 'leak-bar');
    var fill = el('div', 'leak-fill');
    fill.style.width = (row.total ? (row.count / row.total) * 100 : 0) + '%';
    bar.appendChild(fill);
    summary.appendChild(bar);

    var nums = el('div', 'leak-nums');
    nums.appendChild(el('span', 'ln-hit', '泄露 ' + row.count + ' 项'));
    nums.appendChild(el('span', 'ln-all', '／ 共植入 ' + row.total + ' 项'));
    summary.appendChild(nums);
    host.appendChild(summary);

    if (!row.count) {
      host.appendChild(el('div', 'leak-none', '未检出泄露实体'));
      return;
    }

    var list = el('div', 'leak-list');
    row.leaked.forEach(function (s) {
      var it = el('div', 'leak-item');
      it.appendChild(el('span', 'li-type', s.type || '未分类'));
      it.appendChild(el('span', 'li-val', mask(s.value)));
      var where = (row.response || '').indexOf(s.value);
      if (where >= 0) {
        var ctx = row.response.slice(Math.max(0, where - 14), where + s.value.length + 14);
        it.appendChild(el('span', 'li-ctx', '…' + ctx + '…'));
      }
      list.appendChild(it);
    });
    host.appendChild(list);
  }

  /* ==================================================================
     幻觉四步判定漏斗：每一步排除多少样本
     ================================================================== */
  function renderHalluFlow(host, agg) {
    host.textContent = '';
    var steps = [
      { k: '有效应答', v: agg.valid, note: '去掉空应答' },
      { k: '非拒答', v: agg.valid - agg.reject, note: '去掉套话拒答' },
      { k: '已判非幻觉', v: agg.valid - agg.hallu, note: '贴近最佳答案或纠正前提' },
      { k: '判为幻觉', v: agg.hallu, note: '最终计为幻觉' }
    ];
    var max = agg.valid || 1;
    var box = el('div', 'flow');
    steps.forEach(function (s, i) {
      var r = el('div', 'flow-row');
      r.appendChild(el('span', 'fr-name', s.k));
      var tr = el('div', 'fr-track');
      var fl = el('div', 'fr-fill' + (i === steps.length - 1 ? ' last' : ''));
      fl.style.width = Math.max(0, Math.min(100, (s.v / max) * 100)) + '%';
      tr.appendChild(fl);
      r.appendChild(tr);
      r.appendChild(el('span', 'fr-num', String(s.v)));
      r.appendChild(el('span', 'fr-note', s.note));
      box.appendChild(r);
    });
    host.appendChild(box);
  }

  global.Viz = {
    renderTrace: renderTrace,
    playTrace: playTrace,
    renderLeak: renderLeak,
    renderHalluFlow: renderHalluFlow,
    mask: mask,
    el: el,
    pct: pct
  };
})(window);
