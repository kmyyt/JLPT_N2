(() => {
  "use strict";

  const STORAGE_KEY = "jlpt_n2_study_state_v1";
  const EXAM_DATE = "2026-12-06";

  const DEFAULT_STATE = {
    theme: "light", // "light" | "dark"
    ttsRate: 1.0, // 0.6 ~ 1.4
    maskKana: false,
    maskMeaning: false,
    // id -> { status: "외움" | "헷갈림" | "미암기", easeLevel: number, intervalDays: number, nextReviewDate: string, lastReviewedAt: string | null }
    progress: {},
    favorites: [], // word id 배열 (문자열/숫자 모두 지원)
    customDecks: [], // { id: string, name: string, wordIds: (string | number)[] }
    posNotes: {}, // word id -> 메모 문자열
    wrongStats: {} // word id -> { count: number, lastWrongAt: string, lastMode: string }
  };

  // =========================================================
  // 중복 기출 태그 정규화 및 섹션별 DB 병합 로직
  // =========================================================
  function normalizeExamTag(tag) {
    const raw = String(tag ?? "").trim();
    if (!raw) return "";
    // 연도 형태("2021년", "2021년도", "2021")는 "2021년"으로 통일, 일반 태그는 원문 유지
    const yearMatch = raw.match(/^(\d{4})(?:년|년도)?$/);
    if (yearMatch) {
      return `${yearMatch[1]}년`;
    }
    return raw;
  }

  function mergeDuplicateEntries(items) {
    const map = new Map();

    (Array.isArray(items) ? items : []).forEach((item, index) => {
      if (!item || typeof item !== "object" || !item.word) return;

      const wordKey = String(item.word).trim();
      const kanaKey = String(item.kana || "").trim();
      if (!wordKey) return;

      const key = `${wordKey}__${kanaKey}`;

      const rawTags = Array.isArray(item.examTags) && item.examTags.length
        ? item.examTags
        : item.category
        ? [item.category]
        : [];

      const normalizedTags = rawTags
        .map(normalizeExamTag)
        .filter(Boolean);

      if (!map.has(key)) {
        map.set(key, {
          ...item,
          id: item.id !== undefined && item.id !== null ? String(item.id).trim() : `vocab-${index + 1}`,
          type: item.type || "vocab",
          category: item.category || "어휘",
          word: wordKey,
          kana: kanaKey,
          meaning: item.meaning || "",
          pos: item.pos || "",
          examTags: [...new Set(normalizedTags)],
          example: item.example || "",
          exampleKana: item.exampleKana || "",
          exampleMeaning: item.exampleMeaning || "",
          synonyms: Array.isArray(item.synonyms) ? [...new Set(item.synonyms.filter(Boolean))] : [],
          connection: item.connection ?? null,
          compareGrammar: Array.isArray(item.compareGrammar)
            ? [...new Set(item.compareGrammar.filter(Boolean))]
            : []
        });
      } else {
        const existing = map.get(key);
        existing.examTags = [...new Set([...existing.examTags, ...normalizedTags])];

        if (!existing.meaning && item.meaning) existing.meaning = item.meaning;
        if (!existing.pos && item.pos) existing.pos = item.pos;
        if (!existing.example && item.example) {
          existing.example = item.example;
          existing.exampleKana = item.exampleKana || "";
          existing.exampleMeaning = item.exampleMeaning || "";
        }
        if (Array.isArray(item.synonyms) && item.synonyms.length) {
          existing.synonyms = [...new Set([...existing.synonyms, ...item.synonyms.filter(Boolean)])];
        }
        if (Array.isArray(item.compareGrammar) && item.compareGrammar.length) {
          existing.compareGrammar = [
            ...new Set([...existing.compareGrammar, ...item.compareGrammar.filter(Boolean)])
          ];
        }
      }
    });

    return [...map.values()];
  }

  // 섹션별 전용 파일(data-kanji-reading.js, data-notation-exam.js 등)에서 불러온 배열 결합
  const kanjiReadingList = Array.isArray(window.KANJI_READING_DB) ? window.KANJI_READING_DB : [];
  const notationExamList = Array.isArray(window.NOTATION_EXAM_DB) ? window.NOTATION_EXAM_DB : [];
  const wordFormationList = Array.isArray(window.WORD_FORMATION_DB) ? window.WORD_FORMATION_DB : [];
  const extraVocabList = Array.isArray(window.EXTRA_VOCAB_DB) ? window.EXTRA_VOCAB_DB : [];

  const VOCAB_DB = mergeDuplicateEntries([
    ...kanjiReadingList,
    ...notationExamList,
	...wordFormationList,
    ...extraVocabList
	
  ]);

  // 문법·독해 DB (추후 전용 파일로 분리/확장 가능)
  const GRAMMAR_DB = Array.isArray(window.GRAMMAR_DB) ? window.GRAMMAR_DB : [];
  const READING_DB = Array.isArray(window.READING_DB) ? window.READING_DB : [];

  // =========================================================
  // 헬퍼 유틸리티: 중복 기출 표기 / 히라가나 전용 판별 / 한자 역추적
  // =========================================================
  function formatDuplicateExamLabel(examTags) {
    if (!Array.isArray(examTags) || examTags.length < 2) return "";

    const uniqueTags = [...new Set(examTags.map((t) => String(t).trim()).filter(Boolean))];
    if (uniqueTags.length < 2) return "";

    const years = uniqueTags
      .map((tag) => {
        const match = tag.match(/(\d{4})/);
        return match ? `${match[1]}년` : null;
      })
      .filter(Boolean);

    if (years.length >= 2) {
      const sortedYears = [...new Set(years)].sort();
      return `(${sortedYears.join("·")}도 중복 기출)`;
    }

    return `(${uniqueTags.join("·")} 중복 기출)`;
  }

  function isHiraganaOnly(text) {
    if (!text || typeof text !== "string") return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    return /^[ぁ-ゟー・\s]+$/u.test(trimmed);
  }

  function extractKanjiChars(word) {
    if (!word || typeof word !== "string") return [];
    const matches = word.match(/[\u4E00-\u9FFF々]/gu) || [];
    return [...new Set(matches)];
  }

  function findWordsByKanji(kanjiChar, excludeId = null) {
    if (!kanjiChar) return [];
    const targetExcludeId = excludeId !== null && excludeId !== undefined ? String(excludeId) : null;
    return VOCAB_DB.filter(
      (item) =>
        String(item.id) !== targetExcludeId &&
        typeof item.word === "string" &&
        item.word.includes(kanjiChar)
    );
  }

  // =========================================================
  // SRS (에빙하우스 망각곡선 기반 간격 반복) 계산 로직
  // =========================================================
  function getTodayISO(offsetDays = 0) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + offsetDays);
    const yyyy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, "0");
    const dd = String(base.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function calculateNextSrs(prevRecord, ratingOrStatus) {
    const prevInterval = prevRecord && typeof prevRecord.intervalDays === "number" ? prevRecord.intervalDays : 0;
    const prevEase = prevRecord && typeof prevRecord.easeLevel === "number" ? prevRecord.easeLevel : 1;

    let status = "미암기";
    let intervalDays = 1;
    let easeLevel = prevEase;

    if (ratingOrStatus === "완벽함" || ratingOrStatus === "외움") {
      status = "외움";
      easeLevel = Math.min(5, prevEase + 1);
      if (prevInterval <= 0) intervalDays = 3;
      else if (prevInterval < 7) intervalDays = 7;
      else intervalDays = Math.min(60, Math.round(prevInterval * 2.2));
    } else if (ratingOrStatus === "애매함" || ratingOrStatus === "헷갈림") {
      status = "헷갈림";
      easeLevel = Math.max(1, prevEase);
      intervalDays = prevInterval >= 2 ? 2 : 1;
    } else {
      status = "미암기";
      easeLevel = 1;
      intervalDays = 1;
    }

    return {
      status,
      easeLevel,
      intervalDays,
      nextReviewDate: getTodayISO(intervalDays),
      lastReviewedAt: new Date().toISOString()
    };
  }

  function isDueForReview(wordId, state) {
    const key = wordId !== undefined && wordId !== null ? String(wordId) : "";
    const rec = state && state.progress ? state.progress[key] : null;
    if (!rec || !rec.nextReviewDate) return true;
    return rec.nextReviewDate <= getTodayISO(0);
  }

  // =========================================================
  // localStorage 스토어 & JSON 내보내기 / 가져오기 / 초기화
  // =========================================================
  function cloneDefaultState() {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return cloneDefaultState();
      const parsed = JSON.parse(raw);
      return sanitizeState(parsed);
    } catch (_) {
      return cloneDefaultState();
    }
  }

  function sanitizeState(raw) {
    const base = cloneDefaultState();
    if (!raw || typeof raw !== "object") return base;

    base.theme = raw.theme === "dark" ? "dark" : "light";
    const parsedRate = Number(raw.ttsRate);
    base.ttsRate = Number.isFinite(parsedRate) && parsedRate >= 0.6 && parsedRate <= 1.4 ? parsedRate : 1.0;
    base.maskKana = Boolean(raw.maskKana);
    base.maskMeaning = Boolean(raw.maskMeaning);

    if (raw.progress && typeof raw.progress === "object") {
      Object.entries(raw.progress).forEach(([id, entry]) => {
        if (!entry || typeof entry !== "object") return;
        const validStatus = ["외움", "헷갈림", "미암기"].includes(entry.status) ? entry.status : "미암기";
        base.progress[String(id)] = {
          status: validStatus,
          easeLevel: Number.isFinite(Number(entry.easeLevel)) ? Number(entry.easeLevel) : 1,
          intervalDays: Number.isFinite(Number(entry.intervalDays)) ? Number(entry.intervalDays) : 1,
          nextReviewDate: typeof entry.nextReviewDate === "string" ? entry.nextReviewDate : getTodayISO(0),
          lastReviewedAt: entry.lastReviewedAt || null
        };
      });
    }

    if (Array.isArray(raw.favorites)) {
      base.favorites = [...new Set(raw.favorites.map((id) => String(id).trim()).filter(Boolean))];
    }

    if (Array.isArray(raw.customDecks)) {
      base.customDecks = raw.customDecks
        .filter((d) => d && typeof d.name === "string" && d.name.trim())
        .map((d, idx) => ({
          id: typeof d.id === "string" && d.id ? d.id : `deck_${Date.now()}_${idx}`,
          name: d.name.trim(),
          wordIds: Array.isArray(d.wordIds)
            ? [...new Set(d.wordIds.map((id) => String(id).trim()).filter(Boolean))]
            : []
        }));
    }

    if (raw.posNotes && typeof raw.posNotes === "object") {
      Object.entries(raw.posNotes).forEach(([id, note]) => {
        if (typeof note === "string") {
          base.posNotes[String(id)] = note;
        }
      });
    }

    if (raw.wrongStats && typeof raw.wrongStats === "object") {
      Object.entries(raw.wrongStats).forEach(([id, stat]) => {
        if (!stat || typeof stat !== "object") return;
        const cnt = Number(stat.count);
        if (Number.isFinite(cnt) && cnt > 0) {
          base.wrongStats[String(id)] = {
            count: Math.floor(cnt),
            lastWrongAt: typeof stat.lastWrongAt === "string" ? stat.lastWrongAt : new Date().toISOString(),
            lastMode: typeof stat.lastMode === "string" ? stat.lastMode : "quiz"
          };
        }
      });
    }

    return base;
  }

  function saveState(state) {
    const clean = sanitizeState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    return clean;
  }

  function exportStateToJson(state) {
    const payload = {
      app: "JLPT-N2-Study-App",
      version: 2,
      examDate: EXAM_DATE,
      exportedAt: new Date().toISOString(),
      data: sanitizeState(state)
    };
    const jsonText = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `jlpt-n2-backup-${getTodayISO(0)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return jsonText;
  }

  function importStateFromJson(jsonText) {
    if (typeof jsonText !== "string" || !jsonText.trim()) {
      return { ok: false, error: "JSON 파일 내용이 비어 있습니다." };
    }
    try {
      const parsed = JSON.parse(jsonText);
      const rawData = parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object"
        ? parsed.data
        : parsed;

      if (!rawData || typeof rawData !== "object") {
        return { ok: false, error: "유효하지 않은 학습 데이터 형식입니다." };
      }

      const sanitized = sanitizeState(rawData);
      saveState(sanitized);
      return { ok: true, state: sanitized };
    } catch (_) {
      return { ok: false, error: "JSON 구문 오류로 불러오기에 실패했습니다." };
    }
  }

  function resetAllData() {
    localStorage.removeItem(STORAGE_KEY);
    const fresh = cloneDefaultState();
    saveState(fresh);
    return fresh;
  }

  // 전역 네임스페이스 공개 (study.js, quiz.js 및 향후 문법/독해 모듈에서 활용)
  window.JLPTData = {
    STORAGE_KEY,
    EXAM_DATE,
    DEFAULT_STATE,
    VOCAB_DB,
    GRAMMAR_DB,
    READING_DB,
    mergeDuplicateEntries,
    formatDuplicateExamLabel,
    isHiraganaOnly,
    extractKanjiChars,
    findWordsByKanji,
    getTodayISO,
    calculateNextSrs,
    isDueForReview,
    loadState,
    saveState,
    exportStateToJson,
    importStateFromJson,
    resetAllData
  };
})();