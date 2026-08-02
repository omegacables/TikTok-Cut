// 日本語テロップ折返し — backend/pipeline/captions.py の _ja_units/_wrap_lines/_wrap_static の
// 忠実な移植。プレビューの改行を焼き込み(ASS)と完全一致させる（差分テストで検証済み）。
// captions.py 側を変更したら必ずここも同期し、scratchpad の差分テストを再実行すること。
(function () {
  'use strict';

  var JOSHI = new Set(['は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'の', 'や', 'か', 'ね', 'よ', 'わ', 'さ', 'ぞ',
    'な', 'ら', 'り', 'から', 'まで', 'より', 'ので', 'のに', 'けど', 'けれど', 'けれども', 'ても',
    'でも', 'し', 'たり', 'つつ', 'ながら', 'ば', 'には', 'では', 'とは', 'って', 'という',
    'っていう', 'など', 'くらい', 'ぐらい', 'ほど', 'だけ', 'しか', 'こそ', 'さえ', 'とか', 'なら',
    'たら', 'だら', 'ったら', 'ては', 'じゃ']);
  var JODOUSHI = new Set(['です', 'ます', 'だ', 'た', 'て', 'ない', 'ぬ', 'う', 'よう', 'せる', 'させる', 'れる',
    'られる', 'たい', 'そう', 'らしい', 'みたい', 'べき', 'はず', 'わけ', 'ん', 'だろう', 'でしょう',
    'ている', 'てる', 'ちゃう', 'じゃう', 'とく', 'どく', 'ました', 'ません', 'でした', 'ましょう',
    'なんや', 'なの', 'んだ', 'んです']);
  var SENT_END = '。．！？!?';
  var PAUSE = '、，,・';
  var SMALL = 'ーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮ々ゝゞヽヾ';
  var STRIP = '、，, 　。．';   // _wrap_lines の push() で両端から剥がす文字集合

  function isKata(s) {
    if (!s) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (!((c >= 'ァ' && c <= 'ヴ') || 'ー・゛゜ヷヸヹヺ'.indexOf(c) >= 0)) return false;
    }
    return true;
  }

  function jaUnits(text) {
    var toks = null;
    try {
      var root = (typeof window !== 'undefined') ? window : globalThis;
      if (root.tinySegment) toks = root.tinySegment(text).filter(function (t) { return t.trim(); });
    } catch (_) { toks = null; }
    if (!toks || !toks.length) toks = Array.from(text);
    var pieces = [];
    toks.forEach(function (t) {
      var buf = '';
      Array.from(t).forEach(function (c) {
        if (SENT_END.indexOf(c) >= 0 || PAUSE.indexOf(c) >= 0) {
          if (buf) { pieces.push(buf); buf = ''; }
          pieces.push(c);
        } else buf += c;
      });
      if (buf) pieces.push(buf);
    });
    var out = [];
    pieces.forEach(function (t) {
      t = t.trim();
      if (!t) return;
      if (out.length && SMALL.indexOf(Array.from(t)[0]) >= 0) out[out.length - 1] += t;
      else if (out.length && isKata(out[out.length - 1]) && isKata(t)) out[out.length - 1] += t;
      else out.push(t);
    });
    return out;
  }

  function attached(u) {
    if (!u) return true;
    var c0 = Array.from(u)[0];
    if (SENT_END.indexOf(c0) >= 0 || PAUSE.indexOf(c0) >= 0 || SMALL.indexOf(c0) >= 0) return true;
    return JOSHI.has(u) || JODOUSHI.has(u);
  }

  function stripEnds(s) {
    var a = Array.from(s), i = 0, j = a.length;
    while (i < j && STRIP.indexOf(a[i]) >= 0) i++;
    while (j > i && STRIP.indexOf(a[j - 1]) >= 0) j--;
    return a.slice(i, j).join('');
  }

  function wrapLines(text, maxChars, maxLines) {
    text = String(text == null ? '' : text).trim().replace(/\n/g, '');
    if (!text) return [];
    var toks, joiner;
    if (text.indexOf(' ') >= 0) { toks = text.split(/\s+/).filter(Boolean); joiner = ' '; }
    else { toks = jaUnits(text); joiner = ''; }
    var lines = [], line = '';
    var push = function () { var s = stripEnds(line); if (s) lines.push(s); line = ''; };
    toks.forEach(function (tk) {
      // Python の `tk in "文字列"` は部分文字列判定 → indexOf で同義に
      if ('。．'.indexOf(tk) >= 0) return;
      // 読点「、」は改行トリガーにしない（行内に残し、行末の読点は push() が落とす）＝captions.py と同期
      var keep = '！？!?'.indexOf(tk) >= 0;   // Python の `tk in "！？!?"`（部分文字列判定）と同義
      var att = attached(tk);
      var cand = line ? (line + joiner + tk) : tk;
      if (line && !keep && !att && Array.from(cand).length > maxChars) { push(); line = tk; }
      else line = cand;
    });
    if (line) push();
    if (maxLines != null && lines.length > maxLines) {
      var keepN = Math.max(1, maxLines);
      var merged = lines.slice(0, keepN - 1);
      merged.push(lines.slice(keepN - 1).join(joiner));
      lines = merged;
    }
    return lines;
  }

  function wrapStatic(text, maxChars, maxLines) {
    // captions._wrap_static: 手動改行(\n)は行構成を優先（各行はさらに幅折返し・最大4行）
    var manual = String(text == null ? '' : text).split('\n')
      .map(function (s) { return s.trim(); }).filter(Boolean);
    if (manual.length > 1) {
      var limit = Math.max(maxLines, Math.min(4, manual.length));
      var out = [];
      for (var i = 0; i < manual.length; i++) {
        out = out.concat(wrapLines(manual[i], maxChars, null));
        if (out.length >= limit) break;
      }
      return out.slice(0, limit);
    }
    return wrapLines(text, maxChars, maxLines);
  }

  var root = (typeof window !== 'undefined') ? window : globalThis;
  root.jaWrapStatic = wrapStatic;
  root.jaWrapLines = wrapLines;
})();
