/**
 * LoworldUI-Desktop/src/speech/split-for-speech.cjs
 *
 * 읽을 글을 문장마다 나눈다(LoworldUI-AOS의 SherpaSpeech.kt splitForSpeech와 동일한 규칙).
 * - 첫 소리를 빨리 내고 문장마다 실시간 하이라이트(speech.range)를 정확히 짚기 위해 문장 끝에서 바로 끊는다.
 * - 한 문장이 maxLen(기본 120자)보다 길면 쉼표나 공백에서 자른다.
 * - 아주 짧은 조각(< 10자)은 다음 조각과 합쳐 합성 고정 비용을 줄인다.
 * - 원문에서의 글자 범위 [start, end)를 정확히 유지한다.
 */

const PIECE_MAX = 120;
const SENTENCE_END = new Set(['.', '!', '?', '。', '！', '？', '…']);

function isWhitespace(ch) {
  return /\s/.test(ch);
}

/**
 * @param {string} text
 * @param {number} [maxLen=PIECE_MAX]
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
function splitForSpeech(text, maxLen = PIECE_MAX) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const n = text.length;
  const rawSentences = [];
  let i = 0;

  // 1단계: 문장 끝(. ! ? 。 ！ ？ … 뒤 공백) 또는 줄바꿈에서 문장 단위로 분리
  while (i < n) {
    while (i < n && isWhitespace(text[i])) i++;
    if (i >= n) break;

    let j = i;
    while (j < n) {
      const ch = text[j];
      if (ch === '\n') {
        j++;
        break;
      }
      if (SENTENCE_END.has(ch)) {
        j++;
        // 연속된 문장부호(예: ?!, ...) 포함
        while (j < n && SENTENCE_END.has(text[j])) j++;
        if (j >= n || isWhitespace(text[j])) {
          break;
        }
      } else {
        j++;
      }
    }

    let end = j;
    while (end > i && isWhitespace(text[end - 1])) end--;
    if (end > i) {
      rawSentences.push({ start: i, end });
    }
    i = j;
  }

  // 2단계: maxLen보다 긴 문장은 쉼표(,)나 공백에서 분할
  const pieces = [];
  for (const sent of rawSentences) {
    let curStart = sent.start;
    const sentEnd = sent.end;

    while (curStart < sentEnd) {
      while (curStart < sentEnd && isWhitespace(text[curStart])) curStart++;
      if (curStart >= sentEnd) break;

      if (sentEnd - curStart <= maxLen) {
        pieces.push({
          text: text.slice(curStart, sentEnd),
          start: curStart,
          end: sentEnd,
        });
        break;
      }

      const limit = curStart + maxLen;
      const windowStr = text.slice(curStart, limit);
      const commaIdx = windowStr.lastIndexOf(',');
      const spaceIdx = windowStr.lastIndexOf(' ');
      const bestRel = Math.max(commaIdx, spaceIdx);
      const minCut = Math.floor(maxLen / 3);

      let cut;
      if (bestRel > minCut) {
        cut = curStart + bestRel + 1;
      } else {
        cut = limit;
      }

      let pieceEnd = cut;
      while (pieceEnd > curStart && isWhitespace(text[pieceEnd - 1])) pieceEnd--;
      if (pieceEnd > curStart) {
        pieces.push({
          text: text.slice(curStart, pieceEnd),
          start: curStart,
          end: pieceEnd,
        });
      }
      curStart = cut;
    }
  }

  // 3단계: 아주 짧은 조각(< 10자)은 앞 조각과 병합 (단 합쳐도 maxLen 이하일 때)
  const merged = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < 10 && piece.end - last.start <= maxLen) {
      last.end = piece.end;
      last.text = text.slice(last.start, last.end);
    } else {
      merged.push({ ...piece });
    }
  }

  return merged;
}

module.exports = {
  PIECE_MAX,
  splitForSpeech,
};
