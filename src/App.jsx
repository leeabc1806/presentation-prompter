import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Save,
  Trash2,
  FileText,
  Moon,
  Sun,
  User,
  LogIn,
  LogOut,
  X,
  Settings,
  Clock,
  CheckCircle2,
  AlertCircle,
  Star,
  Sparkles,
  BarChart3,
  Copy,
  Trophy,
  ArrowLeft,
  SlidersHorizontal,
  Layers,
  Radio,
  MonitorSmartphone,
  StickyNote,
  Volume2,
  Square,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "./supabaseClient";

const STORAGE_KEY = "karaoke-prompter-projects-v3";
const RECORDINGS_BUCKET = "presentation-recordings";
const LINE_BREAK = String.fromCharCode(10);
const NORMAL_UNITS_PER_SECOND = 4.2;
const AUTO_ADVANCE_DELAY_MS = 300;
const AUTO_FINISH_DELAY_MS = 1000;

const SAMPLE_SCRIPT = [
  "# 도입",
  "안녕하세요. 오늘은 발표 대본 연습 앱을 소개드리겠습니다.",
  "이 앱은 발표자가 대본을 읽으면 현재 문장을 자동으로 강조합니다.",
  "# 핵심 기능",
  "발표 중 어디까지 읽었는지 놓치지 않도록 도와줍니다.",
  "제한시간 안에 발표를 끝낼 수 있도록 속도도 함께 안내합니다.",
].join(LINE_BREAK);

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isSentenceEndChar(char) {
  return [".", "!", "?", "。", "！", "？"].includes(char);
}

function splitSentencesFromLine(text) {
  const result = [];
  let buffer = "";

  Array.from(String(text || "").trim()).forEach((char) => {
    buffer += char;
    if (isSentenceEndChar(char)) {
      const sentence = buffer.trim();
      if (sentence) result.push(sentence);
      buffer = "";
    }
  });

  const rest = buffer.trim();
  if (rest) result.push(rest);
  return result;
}

function normalizeHeading(line) {
  const value = String(line || "").trim();
  if (!value) return "";
  if (value.startsWith("#")) return value.split("#").join("").trim() || "구간";
  if (value.startsWith("[") && value.endsWith("]") && value.length > 2) return value.slice(1, value.length - 1).trim() || "구간";
  if (value.startsWith("파트:")) return value.slice(3).trim() || "구간";
  return "";
}

function parseScriptToItems(text) {
  const lines = String(text || "").replaceAll(String.fromCharCode(13), "").split(LINE_BREAK);
  const items = [];
  let currentSection = "전체";

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const heading = normalizeHeading(trimmed);
    if (heading) {
      currentSection = heading;
      return;
    }
    splitSentencesFromLine(trimmed).forEach((sentence) => {
      items.push({ id: createId(), text: sentence, section: currentSection });
    });
  });

  return items;
}

function isAllowedTextChar(char) {
  const code = char.charCodeAt(0);
  const isHangul = code >= 44032 && code <= 55203;
  const isNumber = code >= 48 && code <= 57;
  const isLower = code >= 97 && code <= 122;
  const isUpper = code >= 65 && code <= 90;
  return isHangul || isNumber || isLower || isUpper;
}

function normalizeText(text) {
  const lowered = String(text || "").toLowerCase();
  const mapped = Array.from(lowered)
    .map((char) => {
      if (isAllowedTextChar(char)) return char;
      if (char.trim() === "") return " ";
      return " ";
    })
    .join("");
  return mapped.split(" ").filter(Boolean).join(" ");
}

function removeCommonParticle(token) {
  const particles = ["으로", "에게", "에서", "부터", "까지", "처럼", "보다", "라는", "이라", "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "도", "만"];
  for (const particle of particles) {
    if (token.endsWith(particle) && token.length > particle.length + 1) return token.slice(0, token.length - particle.length);
  }
  return token;
}

function getWords(text) {
  return normalizeText(text).split(" ").map(removeCommonParticle).filter((word) => word.length > 1);
}

function countSpeechUnits(text) {
  return normalizeText(text).split(" ").join("").length;
}

function tokenSimilarity(target, spoken) {
  const targetWords = getWords(target);
  const spokenWords = getWords(spoken);
  if (!targetWords.length || !spokenWords.length) return 0;

  const used = new Set();
  let matched = 0;

  targetWords.forEach((targetWord) => {
    const hitIndex = spokenWords.findIndex((spokenWord, index) => {
      if (used.has(index)) return false;
      return spokenWord === targetWord || spokenWord.includes(targetWord) || targetWord.includes(spokenWord);
    });
    if (hitIndex >= 0) {
      matched += 1;
      used.add(hitIndex);
    }
  });

  return matched / targetWords.length;
}

function lcsSimilarity(target, spoken) {
  const x = normalizeText(target).split(" ").join("");
  const y = normalizeText(spoken).split(" ").join("");
  if (!x || !y) return 0;

  const prev = new Array(y.length + 1).fill(0);
  const curr = new Array(y.length + 1).fill(0);

  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      curr[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= y.length; j += 1) prev[j] = curr[j];
  }

  return prev[y.length] / x.length;
}

function similarityScore(target, spoken) {
  return Math.max(tokenSimilarity(target, spoken), lcsSimilarity(target, spoken) * 0.92);
}

function getMatchedTokenCount(sentence, transcript) {
  const sentenceWords = getWords(sentence);
  const spokenText = normalizeText(transcript);
  let count = 0;

  for (const word of sentenceWords) {
    if (spokenText.includes(word)) count += 1;
    else break;
  }

  return count;
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    return false;
  }
  return true;
}

function projectToRow(project, userId) {
  return {
    id: project.id,
    user_id: userId,
    title: project.title,
    script: project.script,
    important_map: project.importantMap || {},
    settings: {
      targetMinutes: project.targetMinutes,
      targetSeconds: project.targetSeconds,
      threshold: project.threshold,
      fontSize: project.fontSize,
      lineHeight: project.lineHeight,
      practiceTheme: project.practiceTheme,
      highlightStyle: project.highlightStyle,
      showNextSentence: project.showNextSentence,
      showTranscriptBox: project.showTranscriptBox,
      showTimeCoach: project.showTimeCoach,
      stageLayout: project.stageLayout,
      recordEnabled: project.recordEnabled,
    },
    updated_at: project.updatedAt,
  };
}

function rowToProject(row) {
  const settings = row.settings || {};
  return {
    id: row.id,
    title: row.title,
    script: row.script,
    importantMap: row.important_map || {},
    targetMinutes: settings.targetMinutes ?? 3,
    targetSeconds: settings.targetSeconds ?? 0,
    threshold: settings.threshold ?? 0.7,
    fontSize: settings.fontSize ?? 34,
    lineHeight: settings.lineHeight ?? 1.55,
    practiceTheme: settings.practiceTheme || "dark",
    highlightStyle: settings.highlightStyle || "karaoke",
    showNextSentence: settings.showNextSentence ?? true,
    showTranscriptBox: settings.showTranscriptBox ?? true,
    showTimeCoach: settings.showTimeCoach ?? true,
    stageLayout: settings.stageLayout || "coach",
    recordEnabled: settings.recordEnabled ?? false,
    updatedAt: row.updated_at,
  };
}

function rowToRecording(row, url) {
  return {
    id: row.id,
    title: row.title,
    url,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    extension: row.extension,
    seconds: row.seconds,
    createdAt: row.created_at,
    cloud: true,
  };
}

function shortenSentenceText(sentence) {
  const removable = ["먼저 ", "그럼 ", "이제 ", "그리고 ", "또한 ", "사실 ", "정말 ", "매우 ", "간단히 ", "여러분 ", "제가 생각하기에는 ", "말씀드리자면 ", "중요한 것은 ", "핵심은 "];
  let next = sentence;
  removable.forEach((word) => {
    next = next.replaceAll(word, "");
  });
  if (next.length > 92) return `${next.slice(0, 88)}...`;
  return next.trim() || sentence;
}

function buildTimeScriptSuggestion(items, importantMap, targetSeconds) {
  const sentences = items.map((item) => item.text);
  const units = sentences.map(countSpeechUnits);
  const totalUnits = units.reduce((sum, count) => sum + count, 0);
  const estimatedSeconds = Math.max(1, Math.round(totalUnits / NORMAL_UNITS_PER_SECOND));
  const gapSeconds = estimatedSeconds - targetSeconds;

  if (!sentences.length) {
    return { status: "empty", title: "대본을 입력하면 시간 맞춤 제안을 보여드립니다.", estimatedSeconds: 0, gapSeconds: 0, candidateIndexes: [], suggestedScript: "", tips: [] };
  }

  if (Math.abs(gapSeconds) <= 15) {
    return {
      status: "good",
      title: "현재 대본은 제한시간과 잘 맞는 편입니다.",
      estimatedSeconds,
      gapSeconds,
      candidateIndexes: [],
      suggestedScript: sentences.join(LINE_BREAK),
      tips: ["핵심 문장은 천천히, 설명 문장은 자연스럽게 읽으면 좋습니다.", "실제 발표에서는 긴장 때문에 조금 빨라질 수 있으니 10초 정도 여유를 두세요."],
    };
  }

  if (gapSeconds > 15) {
    const targetUnits = Math.max(1, Math.floor(targetSeconds * NORMAL_UNITS_PER_SECOND));
    const shortened = sentences.map(shortenSentenceText);
    const candidates = sentences
      .map((sentence, index) => ({ index, length: countSpeechUnits(sentence), important: !!importantMap[index] }))
      .filter((item) => !item.important)
      .sort((a, b) => b.length - a.length);

    const keep = new Set(shortened.map((_, index) => index));
    let currentUnits = shortened.reduce((sum, sentence) => sum + countSpeechUnits(sentence), 0);

    for (const item of candidates) {
      if (currentUnits <= targetUnits) break;
      if (sentences.length - keep.size >= Math.max(1, Math.floor(sentences.length * 0.35))) break;
      keep.delete(item.index);
      currentUnits -= countSpeechUnits(shortened[item.index]);
    }

    const suggested = shortened.filter((_, index) => keep.has(index));
    return {
      status: "shorten",
      title: `예상 발표 시간이 목표보다 약 ${formatTime(gapSeconds)} 깁니다.`,
      estimatedSeconds,
      gapSeconds,
      candidateIndexes: candidates.slice(0, 4).map((item) => item.index),
      suggestedScript: suggested.join(LINE_BREAK),
      tips: ["핵심 문장은 유지하고 설명이 반복되는 문장부터 줄이세요.", "긴 문장은 핵심 단어 중심으로 짧게 바꾸는 편이 좋습니다.", "목표 시간보다 10초 정도 짧게 맞추면 실전에서 안정적입니다."],
    };
  }

  const absGap = Math.abs(gapSeconds);
  const expanded = [...sentences];
  const additions = ["먼저 이 주제를 선택한 배경을 짧게 말씀드리겠습니다.", "이 부분이 중요한 이유는 실제 상황에서 바로 도움이 될 수 있기 때문입니다.", "마지막으로 오늘 말씀드린 내용을 한 번 더 정리하겠습니다."];
  if (expanded.length <= 1) expanded.push(additions[0]);
  else expanded.splice(1, 0, additions[0]);
  if (absGap > 35) expanded.splice(Math.max(1, expanded.length - 1), 0, additions[1]);
  if (absGap > 70) expanded.push(additions[2]);

  return {
    status: "expand",
    title: `예상 발표 시간이 목표보다 약 ${formatTime(absGap)} 짧습니다.`,
    estimatedSeconds,
    gapSeconds,
    candidateIndexes: [],
    suggestedScript: expanded.join(LINE_BREAK),
    tips: ["도입부에 배경 설명을 한 문장 추가하면 자연스럽습니다.", "사례나 이유를 한 문장 넣으면 발표가 덜 급하게 들립니다.", "마무리에서 핵심 내용을 다시 정리하면 시간이 안정적으로 채워집니다."],
  };
}

function getSentenceTimeStatus(actual, recommended) {
  if (!actual) return "미측정";
  if (actual > recommended * 1.35) return "느림";
  if (actual < recommended * 0.65) return "빠름";
  return "적정";
}

function getThemeClass(theme) {
  if (theme === "paper") return "min-h-screen bg-stone-100 text-stone-950";
  if (theme === "blue") return "min-h-screen bg-slate-900 text-sky-50";
  return "min-h-screen bg-slate-950 text-white";
}

function getStageCardClass(theme) {
  if (theme === "paper") return "rounded-[2rem] border border-stone-300 bg-white p-6 shadow-2xl sm:p-10";
  if (theme === "blue") return "rounded-[2rem] border border-sky-300/30 bg-sky-950/50 p-6 shadow-2xl shadow-sky-500/10 sm:p-10";
  return "rounded-[2rem] border border-yellow-300/30 bg-white/8 p-6 shadow-2xl shadow-yellow-500/10 sm:p-10";
}

function getHighlightClass(style) {
  if (style === "underline") return "border-b-4 border-yellow-300 text-yellow-200";
  if (style === "box") return "rounded-xl bg-white px-1 text-slate-950 shadow-sm";
  return "rounded-xl bg-yellow-300 px-1 text-slate-950 shadow-sm";
}

function getMutedTextClass(theme) {
  if (theme === "paper") return "text-stone-500";
  return "text-slate-400";
}

function getSectionSummary(items) {
  const sections = [];
  items.forEach((item, index) => {
    const found = sections.find((section) => section.name === item.section);
    if (found) {
      found.count += 1;
      found.end = index;
    } else {
      sections.push({ name: item.section, start: index, end: index, count: 1 });
    }
  });
  return sections;
}

function getBestAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder) return "";

  const candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];

  const testAudio = typeof document !== "undefined" ? document.createElement("audio") : null;

  const supported = candidates.filter((type) => {
    try {
      return window.MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });

  const playable = supported.find((type) => {
    if (!testAudio || !testAudio.canPlayType) return true;
    return testAudio.canPlayType(type).length > 0;
  });

  return playable || supported[0] || "";
}

function getAudioFileExtension(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("webm")) return "webm";
  return "audio";
}

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function PresentationScriptPracticeApp() {
  const SpeechRecognition = getSpeechRecognitionConstructor();
  const [title, setTitle] = useState("나의 발표 대본");
  const [script, setScript] = useState(SAMPLE_SCRIPT);
  const [sentenceItems, setSentenceItems] = useState([]);
  const [importantMap, setImportantMap] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mode, setMode] = useState("edit");
  const [stageLayout, setStageLayout] = useState("coach");
  const [isListening, setIsListening] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [supportStatus, setSupportStatus] = useState(() => (getSpeechRecognitionConstructor() ? "supported" : "unsupported"));
  const [threshold, setThreshold] = useState(0.7);
  const [fontSize, setFontSize] = useState(34);
  const [lineHeight, setLineHeight] = useState(1.55);
  const [darkMode, setDarkMode] = useState(true);
  const [projects, setProjects] = useState(() => loadProjects());
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [wakeLockStatus, setWakeLockStatus] = useState("idle");
  const [lastScore, setLastScore] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [targetMinutes, setTargetMinutes] = useState(3);
  const [targetSeconds, setTargetSeconds] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sentenceStats, setSentenceStats] = useState([]);
  const [reportElapsedSeconds, setReportElapsedSeconds] = useState(0);
  const [copyState, setCopyState] = useState("idle");
  const [practiceTheme, setPracticeTheme] = useState("dark");
  const [highlightStyle, setHighlightStyle] = useState("karaoke");
  const [showNextSentence, setShowNextSentence] = useState(true);
  const [showTranscriptBox, setShowTranscriptBox] = useState(true);
  const [showTimeCoach, setShowTimeCoach] = useState(true);
  const [recordEnabled, setRecordEnabled] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("idle");
  const [recordings, setRecordings] = useState([]);
  const [user, setUser] = useState(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState("signin");
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState("");
  const [cloudStatus, setCloudStatus] = useState(isSupabaseConfigured ? "로그인하면 클라우드 저장을 사용할 수 있습니다." : "Supabase 환경변수가 없어 로컬 저장만 사용 중입니다.");

  const recognitionRef = useRef(null);
  const wakeLockRef = useRef(null);
  const modeRef = useRef("edit");
  const advanceByRef = useRef(null);
  const togglePauseRef = useRef(null);
  const currentIndexRef = useRef(0);
  const sentenceItemsRef = useRef([]);
  const importantMapRef = useRef({});
  const pausedRef = useRef(false);
  const autoAdvanceRef = useRef(true);
  const shouldListenRef = useRef(false);
  const transcriptRef = useRef("");
  const timerRef = useRef(null);
  const practiceStartedAtRef = useRef(null);
  const accumulatedElapsedRef = useRef(0);
  const currentSentenceStartedAtRef = useRef(null);
  const lastAdvanceRef = useRef(0);
  const pendingAdvanceTimeoutRef = useRef(null);
  const pendingFinishTimeoutRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const mediaStreamRef = useRef(null);
  const recordingMimeTypeRef = useRef("");

  const editorItems = useMemo(() => parseScriptToItems(script), [script]);
  const activeItems = sentenceItems.length ? sentenceItems : editorItems;
  const activeSentences = activeItems.map((item) => item.text);
  const sectionSummary = useMemo(() => getSectionSummary(activeItems), [activeItems]);
  const currentItem = activeItems[currentIndex] || { text: "", section: "전체" };
  const currentSentence = currentItem.text;
  const previousSentence = activeItems[currentIndex - 1]?.text || "이전 문장이 없습니다.";
  const nextSentence = activeItems[currentIndex + 1]?.text || "마지막 문장입니다.";
  const currentSection = currentItem.section || "전체";
  const sectionItems = activeItems.filter((item) => item.section === currentSection);
  const sectionIndexes = activeItems.map((item, index) => ({ item, index })).filter((entry) => entry.item.section === currentSection).map((entry) => entry.index);
  const sectionPosition = Math.max(1, sectionIndexes.indexOf(currentIndex) + 1);
  const sectionTotal = Math.max(1, sectionItems.length);
  const combinedTranscript = `${transcript} ${interimTranscript}`.trim();
  const targetTimeSeconds = Math.max(10, Number(targetMinutes || 0) * 60 + Number(targetSeconds || 0));
  const speechUnitsBySentence = useMemo(() => activeSentences.map(countSpeechUnits), [activeSentences]);
  const totalSpeechUnits = useMemo(() => Math.max(1, speechUnitsBySentence.reduce((sum, count) => sum + count, 0)), [speechUnitsBySentence]);
  const completedSpeechUnits = useMemo(() => speechUnitsBySentence.slice(0, currentIndex).reduce((sum, count) => sum + count, 0), [speechUnitsBySentence, currentIndex]);
  const progressPercent = activeItems.length ? Math.round(((currentIndex + 1) / activeItems.length) * 100) : 0;
  const currentSentenceUnits = speechUnitsBySentence[currentIndex] || 1;
  const targetPacePerSecond = totalSpeechUnits / targetTimeSeconds;
  const actualProgressRatio = completedSpeechUnits / totalSpeechUnits;
  const expectedProgressRatio = Math.min(1, elapsedSeconds / targetTimeSeconds);
  const paceGap = actualProgressRatio - expectedProgressRatio;
  const remainingSeconds = Math.max(0, targetTimeSeconds - elapsedSeconds);
  const currentSentenceRecommendedSeconds = Math.max(3, Math.round((currentSentenceUnits / totalSpeechUnits) * targetTimeSeconds));
  const elapsedPace = elapsedSeconds > 3 && completedSpeechUnits > 0 ? completedSpeechUnits / elapsedSeconds : 0;
  const estimatedTotalSeconds = elapsedPace > 0 ? Math.round(totalSpeechUnits / elapsedPace) : targetTimeSeconds;
  const estimatedFinishGap = estimatedTotalSeconds - targetTimeSeconds;
  const currentScore = useMemo(() => {
    if (!currentSentence || !combinedTranscript) return 0;
    return similarityScore(currentSentence, combinedTranscript);
  }, [currentSentence, combinedTranscript]);
  const matchedCount = useMemo(() => getMatchedTokenCount(currentSentence, combinedTranscript), [currentSentence, combinedTranscript]);
  const timeSuggestion = useMemo(() => buildTimeScriptSuggestion(activeItems, importantMap, targetTimeSeconds), [activeItems, importantMap, targetTimeSeconds]);

  const paceStatus = elapsedSeconds < 5 || !elapsedPace
    ? { label: "측정 중", hint: "읽기 시작하면 제한시간 대비 속도를 계산합니다.", tone: "text-slate-300" }
    : elapsedSeconds >= targetTimeSeconds
      ? { label: "시간 초과", hint: "목표 시간이 지났습니다. 남은 문장은 핵심 위주로 마무리하세요.", tone: "text-rose-300" }
      : estimatedFinishGap > 0
        ? { label: "속도 올리기", hint: `현재 속도라면 목표보다 ${formatTime(estimatedFinishGap)} 늦게 끝날 수 있어요. 다음 문장은 조금 더 빠르게 읽어보세요.`, tone: "text-rose-300" }
        : estimatedFinishGap < -Math.max(10, Math.round(targetTimeSeconds * 0.03)) || paceGap > 0.1
          ? { label: "여유 있음", hint: "목표 시간보다 빠르게 끝날 흐름입니다. 중요한 문장은 천천히 말해도 됩니다.", tone: "text-emerald-300" }
          : { label: "좋은 속도", hint: "현재 속도면 목표 시간 안에 발표를 마칠 가능성이 높아요.", tone: "text-yellow-200" };

  const appClass = darkMode ? "min-h-screen bg-slate-950 text-white" : "min-h-screen bg-slate-50 text-slate-950";
  const cardClass = darkMode ? "rounded-3xl border border-white/10 bg-white/8 shadow-2xl shadow-black/20 backdrop-blur" : "rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/70";
  const stageClass = getThemeClass(practiceTheme);
  const mutedText = getMutedTextClass(practiceTheme);
  const stageIsLive = stageLayout === "live";
  const stageIsNotes = stageLayout === "notes";

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!supabase) return undefined;

    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setUser(data.session?.user || null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      if (session?.user) setAuthDialogOpen(false);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user || !supabase) return;
    loadCloudData(user.id);
  }, [user]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    sentenceItemsRef.current = sentenceItems;
  }, [sentenceItems]);

  useEffect(() => {
    importantMapRef.current = importantMap;
  }, [importantMap]);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    autoAdvanceRef.current = autoAdvance;
  }, [autoAdvance]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (modeRef.current !== "practice") return;
      if (event.key === "ArrowRight" || event.key === "PageDown") advanceByRef.current?.(1);
      if (event.key === "ArrowLeft" || event.key === "PageUp") advanceByRef.current?.(-1);
      if (event.key === " ") {
        event.preventDefault();
        togglePauseRef.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      stopRecording(false);
      try {
        shouldListenRef.current = false;
        recognitionRef.current?.stop();
      } catch {
        return;
      }
    };
  }, []);

  function prepareSentences() {
    const parsed = parseScriptToItems(script);
    setSentenceItems(parsed);
    sentenceItemsRef.current = parsed;
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    resetTranscriptOnly();
    setLastScore(0);
    return parsed;
  }

  function resetTranscriptOnly() {
    clearPendingAdvance();
    transcriptRef.current = "";
    setTranscript("");
    setInterimTranscript("");
  }

  function clearPendingAdvance() {
    if (pendingAdvanceTimeoutRef.current) {
      clearTimeout(pendingAdvanceTimeoutRef.current);
      pendingAdvanceTimeoutRef.current = null;
    }
    if (pendingFinishTimeoutRef.current) {
      clearTimeout(pendingFinishTimeoutRef.current);
      pendingFinishTimeoutRef.current = null;
    }
  }

  function getLiveElapsedSeconds() {
    let total = accumulatedElapsedRef.current;
    if (practiceStartedAtRef.current) total += Math.floor((Date.now() - practiceStartedAtRef.current) / 1000);
    return total;
  }

  function startPracticeTimer(reset = false) {
    if (timerRef.current) clearInterval(timerRef.current);
    if (reset) {
      accumulatedElapsedRef.current = 0;
      setElapsedSeconds(0);
    }
    practiceStartedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSeconds(getLiveElapsedSeconds());
    }, 500);
  }

  function pausePracticeTimer() {
    accumulatedElapsedRef.current = getLiveElapsedSeconds();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    practiceStartedAtRef.current = null;
    setElapsedSeconds(accumulatedElapsedRef.current);
  }

  function stopPracticeTimer() {
    const finalSeconds = getLiveElapsedSeconds();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    practiceStartedAtRef.current = null;
    accumulatedElapsedRef.current = finalSeconds;
    setElapsedSeconds(finalSeconds);
    return finalSeconds;
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        setWakeLockStatus("on");
        wakeLockRef.current.addEventListener("release", () => setWakeLockStatus("released"));
      } else {
        setWakeLockStatus("unsupported");
      }
    } catch {
      setWakeLockStatus("blocked");
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      setWakeLockStatus("idle");
    } catch {
      setWakeLockStatus("idle");
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!supabase) {
      setAuthStatus("Supabase 환경변수가 필요합니다.");
      return;
    }

    setAuthStatus(authMode === "signin" ? "로그인 중..." : "계정 생성 중...");
    const credentials = { email: authEmail.trim(), password: authPassword };
    const { error } = authMode === "signin"
      ? await supabase.auth.signInWithPassword(credentials)
      : await supabase.auth.signUp(credentials);

    if (error) {
      setAuthStatus(error.message);
      return;
    }

    setAuthPassword("");
    setAuthStatus(authMode === "signin" ? "로그인되었습니다." : "가입 요청이 완료되었습니다. 이메일 확인 설정이 켜져 있다면 메일을 확인하세요.");
  }

  function openAuthDialog(nextMode) {
    setAuthMode(nextMode);
    setAuthStatus("");
    setAuthDialogOpen(true);
  }

  async function handleGoogleSignIn() {
    if (!supabase) {
      setAuthStatus("Supabase 환경변수가 필요합니다.");
      return;
    }

    setAuthStatus("Google 로그인으로 이동합니다...");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });

    if (error) setAuthStatus(error.message);
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setProjects(loadProjects());
    setRecordings([]);
    setSelectedProjectId("");
    setCloudStatus("로그아웃했습니다. 로컬 저장 목록을 표시합니다.");
  }

  async function loadCloudData(userId) {
    if (!supabase) return;
    setCloudStatus("클라우드 데이터를 불러오는 중...");

    const { data: projectRows, error: projectError } = await supabase
      .from("presentation_projects")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (projectError) {
      setCloudStatus(`대본 불러오기 실패: ${projectError.message}`);
      return;
    }

    const cloudProjects = (projectRows || []).map(rowToProject);
    setProjects(cloudProjects);

    const { data: recordingRows, error: recordingError } = await supabase
      .from("presentation_recordings")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (recordingError) {
      setCloudStatus(`녹음 불러오기 실패: ${recordingError.message}`);
      return;
    }

    const recordingList = await Promise.all((recordingRows || []).map(async (row) => {
      const { data } = await supabase.storage
        .from(RECORDINGS_BUCKET)
        .createSignedUrl(row.storage_path, 60 * 60);
      return rowToRecording(row, data?.signedUrl || "");
    }));

    setRecordings(recordingList);
    setCloudStatus("클라우드 데이터가 동기화되었습니다.");
  }

  async function saveProjectToCloud(project) {
    if (!supabase || !user) return true;
    const { error } = await supabase
      .from("presentation_projects")
      .upsert(projectToRow(project, user.id), { onConflict: "id" });
    if (error) {
      setCloudStatus(`클라우드 저장 실패: ${error.message}`);
      return false;
    }
    setCloudStatus("클라우드에 저장되었습니다.");
    return true;
  }

  async function saveRecordingToCloud(recording, blob) {
    if (!supabase || !user) return;

    const storagePath = `${user.id}/${recording.id}.${recording.extension}`;
    const { error: uploadError } = await supabase.storage
      .from(RECORDINGS_BUCKET)
      .upload(storagePath, blob, { contentType: recording.mimeType, upsert: false });

    if (uploadError) {
      setCloudStatus(`녹음 업로드 실패: ${uploadError.message}`);
      return;
    }

    const { error: insertError } = await supabase.from("presentation_recordings").insert({
      id: recording.id,
      user_id: user.id,
      project_id: projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : null,
      title: recording.title,
      storage_path: storagePath,
      mime_type: recording.mimeType,
      extension: recording.extension,
      seconds: recording.seconds,
      created_at: recording.createdAt,
    });

    if (insertError) {
      setCloudStatus(`녹음 기록 저장 실패: ${insertError.message}`);
      return;
    }

    setCloudStatus("녹음이 클라우드에 저장되었습니다.");
  }

  async function startRecording() {
    if (!recordEnabled) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setRecordingStatus("unsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordingChunksRef.current = [];

      const mimeType = getBestAudioMimeType();
      let recorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        recordingMimeTypeRef.current = mimeType;
      } catch {
        recorder = new MediaRecorder(stream);
        recordingMimeTypeRef.current = recorder.mimeType || "";
      }
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const recordedType = recordingMimeTypeRef.current || recordingChunksRef.current[0]?.type || "audio/mp4";
        const blob = new Blob(recordingChunksRef.current, { type: recordedType });
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const recording = {
            id: createId(),
            title,
            url,
            mimeType: recordedType,
            extension: getAudioFileExtension(recordedType),
            seconds: getLiveElapsedSeconds(),
            createdAt: new Date().toISOString(),
            cloud: false,
          };
          setRecordings((prev) => [
            recording,
            ...prev,
          ].slice(0, user ? 20 : 5));
          await saveRecordingToCloud(recording, blob);
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
        setIsRecording(false);
        setRecordingStatus("saved");
      };
      recorder.start(1000);
      setIsRecording(true);
      setRecordingStatus("recording");
    } catch {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      setRecordingStatus("blocked");
      setIsRecording(false);
    }
  }

  function stopRecording(createFile = true) {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        if (createFile) mediaRecorderRef.current.stop();
        else {
          mediaRecorderRef.current.onstop = null;
          mediaRecorderRef.current.stop();
        }
      }
    } catch {
      setIsRecording(false);
    }
    if (!createFile && mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }

  function startPractice() {
    const parsed = prepareSentences();
    if (!parsed.length) return;
    setSentenceStats([]);
    setReportElapsedSeconds(0);
    currentSentenceStartedAtRef.current = Date.now();
    setMode("practice");
    setIsPaused(false);
    startPracticeTimer(true);
    requestWakeLock();
    startRecording();
    setTimeout(() => startListening(), 250);
  }

  function startListening() {
    if (!SpeechRecognition) {
      setSupportStatus("unsupported");
      return;
    }

    try {
      shouldListenRef.current = true;
      if (recognitionRef.current) recognitionRef.current.stop();
      const recognition = new SpeechRecognition();
      recognition.lang = "ko-KR";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        setIsListening(true);
        setSupportStatus("supported");
      };
      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const text = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += `${text} `;
          else interimText += `${text} `;
        }
        if (finalText) {
          const nextFinal = `${transcriptRef.current} ${finalText}`.trim();
          transcriptRef.current = nextFinal;
          setTranscript(nextFinal);
          evaluateSpokenText(nextFinal);
        }
        const cleanInterim = interimText.trim();
        setInterimTranscript(cleanInterim);
        if (cleanInterim) evaluateSpokenText(`${transcriptRef.current} ${cleanInterim}`.trim());
      };
      recognition.onerror = (event) => {
        if (event.error === "not-allowed") setSupportStatus("permission-denied");
        else if (event.error === "no-speech") setSupportStatus("no-speech");
        else setSupportStatus("error");
      };
      recognition.onend = () => {
        setIsListening(false);
        if (shouldListenRef.current && !pausedRef.current) {
          setTimeout(() => {
            try {
              recognition.start();
            } catch {
              return;
            }
          }, 650);
        }
      };
      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setSupportStatus("error");
      setIsListening(false);
    }
  }

  function stopListening() {
    shouldListenRef.current = false;
    clearPendingAdvance();
    try {
      recognitionRef.current?.stop();
    } catch {
      return;
    }
    setIsListening(false);
  }

  function recordSentenceDuration(index) {
    const list = sentenceItemsRef.current;
    if (!list[index] || !currentSentenceStartedAtRef.current) return;
    const duration = Math.max(1, Math.round((Date.now() - currentSentenceStartedAtRef.current) / 1000));
    const important = !!importantMapRef.current[index];
    setSentenceStats((prev) => {
      const copy = [...prev];
      const old = copy[index] || { index, text: list[index].text, section: list[index].section, duration: 0, important };
      copy[index] = { ...old, text: list[index].text, section: list[index].section, important, duration: old.duration + duration };
      return copy;
    });
  }

  function advanceBy(delta) {
    const list = sentenceItemsRef.current;
    if (!list.length) return;
    const from = currentIndexRef.current;
    const to = Math.max(0, Math.min(list.length - 1, from + delta));
    if (from !== to) {
      recordSentenceDuration(from);
      currentSentenceStartedAtRef.current = Date.now();
      currentIndexRef.current = to;
      setCurrentIndex(to);
      resetTranscriptOnly();
      setLastScore(0);
    }
  }

  function evaluateSpokenText(spoken) {
    const idx = currentIndexRef.current;
    const list = sentenceItemsRef.current;
    const target = list[idx]?.text;
    if (!target || pausedRef.current || !autoAdvanceRef.current) return;
    const score = similarityScore(target, spoken);
    setLastScore(score);
    const targetLength = countSpeechUnits(target);
    const spokenLength = countSpeechUnits(spoken);
    const lengthEnough = spokenLength >= Math.min(targetLength * 0.55, Math.max(1, targetLength - 2));
    if (score >= threshold && lengthEnough && Date.now() - lastAdvanceRef.current > 1100) {
      clearPendingAdvance();
      pendingAdvanceTimeoutRef.current = setTimeout(() => {
        pendingAdvanceTimeoutRef.current = null;
        if (currentIndexRef.current === idx && !pausedRef.current && autoAdvanceRef.current) {
          lastAdvanceRef.current = Date.now();
          if (idx === list.length - 1) {
            pendingFinishTimeoutRef.current = setTimeout(() => {
              pendingFinishTimeoutRef.current = null;
              if (currentIndexRef.current === idx && !pausedRef.current && autoAdvanceRef.current) finishPractice();
            }, AUTO_FINISH_DELAY_MS);
          } else {
            advanceBy(1);
          }
        }
      }, AUTO_ADVANCE_DELAY_MS);
    } else {
      clearPendingAdvance();
    }
  }

  function goNext() {
    advanceBy(1);
  }

  function goPrev() {
    advanceBy(-1);
  }

  function togglePause() {
    setIsPaused((prev) => {
      const next = !prev;
      if (next) {
        stopListening();
        pausePracticeTimer();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording" && typeof mediaRecorderRef.current.pause === "function") mediaRecorderRef.current.pause();
      } else {
        startPracticeTimer(false);
        currentSentenceStartedAtRef.current = Date.now();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused" && typeof mediaRecorderRef.current.resume === "function") mediaRecorderRef.current.resume();
        setTimeout(() => startListening(), 150);
      }
      return next;
    });
  }

  advanceByRef.current = advanceBy;
  togglePauseRef.current = togglePause;

  function resetCurrentSentence() {
    resetTranscriptOnly();
    setLastScore(0);
    currentSentenceStartedAtRef.current = Date.now();
  }

  function finishPractice() {
    recordSentenceDuration(currentIndexRef.current);
    stopListening();
    const finalSeconds = stopPracticeTimer();
    stopRecording(true);
    setReportElapsedSeconds(finalSeconds);
    releaseWakeLock();
    setIsPaused(false);
    setMode("report");
  }

  async function saveCurrentProject() {
    const project = {
      id: selectedProjectId || createId(),
      title: title.trim() || "제목 없는 발표",
      script,
      importantMap,
      targetMinutes,
      targetSeconds,
      threshold,
      fontSize,
      lineHeight,
      practiceTheme,
      highlightStyle,
      showNextSentence,
      showTranscriptBox,
      showTimeCoach,
      stageLayout,
      recordEnabled,
      updatedAt: new Date().toISOString(),
    };
    const nextProjects = [project, ...projects.filter((item) => item.id !== project.id)].slice(0, 12);
    setProjects(nextProjects);
    setSelectedProjectId(project.id);
    saveProjects(nextProjects);
    await saveProjectToCloud(project);
  }

  function loadProject(id) {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    setSelectedProjectId(id);
    setTitle(project.title);
    setScript(project.script);
    setImportantMap(project.importantMap || {});
    setTargetMinutes(project.targetMinutes ?? 3);
    setTargetSeconds(project.targetSeconds ?? 0);
    setThreshold(project.threshold ?? 0.7);
    setFontSize(project.fontSize ?? 34);
    setLineHeight(project.lineHeight ?? 1.55);
    setPracticeTheme(project.practiceTheme || "dark");
    setHighlightStyle(project.highlightStyle || "karaoke");
    setShowNextSentence(project.showNextSentence ?? true);
    setShowTranscriptBox(project.showTranscriptBox ?? true);
    setShowTimeCoach(project.showTimeCoach ?? true);
    setStageLayout(project.stageLayout || "coach");
    setRecordEnabled(project.recordEnabled ?? false);
    setSentenceItems([]);
    setCurrentIndex(0);
  }

  async function deleteProject(id) {
    const nextProjects = projects.filter((item) => item.id !== id);
    setProjects(nextProjects);
    saveProjects(nextProjects);
    if (selectedProjectId === id) setSelectedProjectId("");
    if (supabase && user) {
      const { error } = await supabase.from("presentation_projects").delete().eq("id", id).eq("user_id", user.id);
      setCloudStatus(error ? `클라우드 삭제 실패: ${error.message}` : "클라우드에서 삭제되었습니다.");
    }
  }

  function toggleImportant(index) {
    setImportantMap((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  function applySuggestedScript() {
    if (!timeSuggestion.suggestedScript) return;
    setScript(timeSuggestion.suggestedScript);
    setSentenceItems([]);
    setCurrentIndex(0);
  }

  async function copySuggestedScript() {
    try {
      await navigator.clipboard.writeText(timeSuggestion.suggestedScript || "");
      setCopyState("done");
      setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1200);
    }
  }

  function handlePracticeTap(event) {
    const target = event.target;
    if (target && target.closest && target.closest("button")) return;
    if (event.clientX < window.innerWidth / 2) goPrev();
    else goNext();
  }

  function renderSentenceHighlight(sentence) {
    const parts = sentence.split(" ");
    const highlightClass = getHighlightClass(highlightStyle);
    return parts.map((part, index) => {
      const core = removeCommonParticle(normalizeText(part));
      const isMatched = index < matchedCount || (core && normalizeText(combinedTranscript).includes(core));
      return (
        <span key={`${part}-${index}`} className={isMatched ? highlightClass : practiceTheme === "paper" ? "text-stone-950" : "text-white"}>
          {part}{index < parts.length - 1 ? " " : ""}
        </span>
      );
    });
  }

  function renderStageMain() {
    const mainFont = stageIsLive ? fontSize + 8 : fontSize;
    return (
      <AnimatePresence mode="wait">
        <motion.section key={currentIndex} initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -20, scale: 0.98 }} transition={{ duration: 0.25 }} className={getStageCardClass(practiceTheme)}>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-yellow-300 px-3 py-1 text-xs font-black text-slate-950">{currentSection} · {sectionPosition}/{sectionTotal}</span>
            {importantMap[currentIndex] && <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-xs font-black text-slate-950"><Star className="h-3 w-3 fill-current" /> 핵심 문장</span>}
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs">권장 {currentSentenceRecommendedSeconds}초</span>
          </div>
          <div className="tracking-[-0.02em]" style={{ fontSize: `${mainFont}px`, lineHeight }}>
            {renderSentenceHighlight(currentSentence)}
          </div>
        </motion.section>
      </AnimatePresence>
    );
  }

  if (mode === "practice") {
    return (
      <div className={stageClass} onPointerUp={handlePracticeTap}>
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-5 sm:px-6">
          <header className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className={`text-sm ${mutedText}`}>{title || "발표 연습"}</p>
              <h1 className="text-xl font-bold sm:text-2xl">{stageIsLive ? "실전 발표 모드" : stageIsNotes ? "태블릿 발표자 노트" : "발표자 모드"}</h1>
              <p className={`mt-1 text-xs ${mutedText}`}>화면 왼쪽 탭: 이전 · 오른쪽 탭: 다음 · 방향키/리모컨 지원</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {isRecording && <span className="inline-flex items-center gap-2 rounded-full bg-rose-500 px-3 py-2 text-sm font-bold text-white"><Radio className="h-4 w-4" /> 녹음 중</span>}
              <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-sm">
                {isListening ? <Mic className="h-4 w-4 text-emerald-300" /> : <MicOff className="h-4 w-4 text-rose-300" />}
                {isListening ? "음성 인식 중" : isPaused ? "일시정지" : "대기 중"}
              </div>
            </div>
          </header>

          <div className="mb-4 h-3 overflow-hidden rounded-full bg-white/10">
            <motion.div className="h-full rounded-full bg-yellow-300" initial={{ width: 0 }} animate={{ width: `${progressPercent}%` }} transition={{ duration: 0.35 }} />
          </div>

          <main className={stageIsNotes ? "grid flex-1 gap-5 lg:grid-cols-[1.1fr_0.9fr]" : "flex flex-1 flex-col justify-center gap-5"}>
            <div className={stageIsNotes ? "flex flex-col gap-5" : "flex flex-col justify-center gap-5"}>
              {!stageIsLive && (
                <div className="grid gap-4 sm:grid-cols-3 sm:items-center">
                  <MetricCard title="진행 상황" value={`${currentIndex + 1} / ${activeItems.length}`} sub={`${currentSection} ${sectionPosition}/${sectionTotal}`} />
                  <MetricCard title="남은 시간" value={formatTime(remainingSeconds)} sub={`경과 ${formatTime(elapsedSeconds)} / 목표 ${formatTime(targetTimeSeconds)}`} />
                  <MetricCard title="속도 상태" value={paceStatus.label} sub={`예상 종료 ${formatTime(estimatedTotalSeconds)}`} valueClass={paceStatus.tone} />
                </div>
              )}

              {stageIsLive && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <MetricCard title="남은 시간" value={formatTime(remainingSeconds)} sub="실전용 최소 정보" />
                  <MetricCard title="현재 파트" value={currentSection} sub={`${sectionPosition}/${sectionTotal}`} />
                  <MetricCard title="전체 진행" value={`${progressPercent}%`} sub={`${currentIndex + 1}/${activeItems.length}`} />
                </div>
              )}

              {renderStageMain()}

              {showNextSentence && (
                <section className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="mb-2 flex items-center gap-2">
                      <SkipBack className="h-4 w-4 text-slate-400" />
                      <p className={`text-sm font-bold ${mutedText}`}>이전 문장</p>
                    </div>
                    <p className="text-base leading-relaxed opacity-70 sm:text-lg">{previousSentence}</p>
                  </div>
                  <div className="rounded-3xl border border-yellow-300/20 bg-yellow-300/10 p-5">
                    <div className="mb-2 flex items-center gap-2">
                      <SkipForward className="h-4 w-4 text-yellow-200" />
                      <p className="text-sm font-bold text-yellow-200">다음 문장</p>
                    </div>
                    <p className="text-base font-semibold leading-relaxed sm:text-lg">{nextSentence}</p>
                  </div>
                </section>
              )}

              {!stageIsLive && showTimeCoach && (
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <div className="mb-3 flex items-center gap-2 text-yellow-200"><Clock className="h-5 w-5" /><p className="font-semibold">시간 코치</p></div>
                  <p className="text-base leading-relaxed">{paceStatus.hint}</p>
                  <p className={`mt-2 text-sm ${mutedText}`}>현재 문장 권장 시간: 약 {currentSentenceRecommendedSeconds}초 · 목표 속도: 초당 {targetPacePerSecond.toFixed(1)}글자 기준{elapsedSeconds > 5 && ` · 목표 대비 ${estimatedFinishGap > 0 ? `${formatTime(estimatedFinishGap)} 늦음` : `${formatTime(Math.abs(estimatedFinishGap))} 빠름`}`}</p>
                </section>
              )}

              {!stageIsLive && showTranscriptBox && (
                <section className="rounded-3xl border border-white/10 bg-black/25 p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className={`text-sm ${mutedText}`}>실시간 인식 내용 · 유사도 {Math.round(Math.max(currentScore, lastScore) * 100)}%</p>
                    <button onClick={resetCurrentSentence} className="rounded-full bg-white/10 px-3 py-1 text-xs active:scale-95">다시 듣기</button>
                  </div>
                  <p className="min-h-8 text-base">{combinedTranscript || "말을 시작하면 여기에 인식된 내용이 표시됩니다."}</p>
                </section>
              )}
            </div>

            {stageIsNotes && (
              <aside className="space-y-4">
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <div className="mb-3 flex items-center gap-2 text-yellow-200"><StickyNote className="h-5 w-5" /><p className="font-bold">PPT 발표자 노트</p></div>
                  <div className="space-y-3">
                    <NoteLine label="이전" text={previousSentence} dim />
                    <NoteLine label="현재" text={currentSentence} strong />
                    <NoteLine label="다음" text={nextSentence} />
                  </div>
                </section>
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="mb-3 font-bold">파트 목차</p>
                  <div className="space-y-2">
                    {sectionSummary.map((section) => {
                      const active = section.name === currentSection;
                      return <div key={section.name} className={active ? "rounded-2xl bg-yellow-300 px-4 py-3 text-sm font-black text-slate-950" : "rounded-2xl bg-white/10 px-4 py-3 text-sm"}>{section.name} · {section.count}문장</div>;
                    })}
                  </div>
                </section>
                <section className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="mb-3 font-bold">핵심 문장</p>
                  <div className="space-y-2">
                    {activeItems.map((item, index) => importantMap[index] ? <p key={index} className="rounded-2xl bg-amber-400/20 p-3 text-sm">{index + 1}. {item.text}</p> : null)}
                    {!activeItems.some((_, index) => importantMap[index]) && <p className={mutedText}>핵심 표시한 문장이 없습니다.</p>}
                  </div>
                </section>
              </aside>
            )}
          </main>

          <footer className="sticky bottom-0 mt-5 grid grid-cols-5 gap-2 rounded-3xl border border-white/10 bg-slate-950/90 p-3 text-white backdrop-blur sm:gap-3">
            <button onClick={goPrev} className="flex flex-col items-center justify-center rounded-2xl bg-white/10 px-2 py-4 text-sm active:scale-95"><SkipBack className="mb-1 h-5 w-5" /> 이전</button>
            <button onClick={togglePause} className="flex flex-col items-center justify-center rounded-2xl bg-yellow-300 px-2 py-4 text-sm font-bold text-slate-950 active:scale-95">{isPaused ? <Play className="mb-1 h-5 w-5" /> : <Pause className="mb-1 h-5 w-5" />}{isPaused ? "재개" : "정지"}</button>
            <button onClick={goNext} className="flex flex-col items-center justify-center rounded-2xl bg-white/10 px-2 py-4 text-sm active:scale-95"><SkipForward className="mb-1 h-5 w-5" /> 다음</button>
            <button onClick={resetCurrentSentence} className="flex flex-col items-center justify-center rounded-2xl bg-white/10 px-2 py-4 text-sm active:scale-95"><RotateCcw className="mb-1 h-5 w-5" /> 초기화</button>
            <button onClick={finishPractice} className="flex flex-col items-center justify-center rounded-2xl bg-rose-500 px-2 py-4 text-sm font-bold active:scale-95"><Square className="mb-1 h-5 w-5" /> 종료</button>
          </footer>
        </div>
      </div>
    );
  }

  if (mode === "report") {
    const fullStats = activeItems.map((item, index) => {
      const actual = sentenceStats[index]?.duration || 0;
      const recommended = Math.max(3, Math.round(((countSpeechUnits(item.text) || 1) / totalSpeechUnits) * targetTimeSeconds));
      return { index, sentence: item.text, section: item.section, actual, recommended, important: !!importantMap[index], status: getSentenceTimeStatus(actual, recommended) };
    });
    const slowStats = [...fullStats].sort((a, b) => b.actual - a.actual).slice(0, 3);
    const finalGap = reportElapsedSeconds - targetTimeSeconds;
    const averageUnitsPerSecond = reportElapsedSeconds > 0 ? totalSpeechUnits / reportElapsedSeconds : 0;

    return (
      <div className={appClass}>
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
          <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-yellow-300 px-4 py-2 text-sm font-bold text-slate-950"><Trophy className="h-4 w-4" /> 발표 리허설 결과</div>
              <h1 className="text-3xl font-black tracking-tight sm:text-5xl">{title}</h1>
              <p className={darkMode ? "mt-3 text-slate-300" : "mt-3 text-slate-600"}>연습 시간, 문장별 속도, 녹음 기록을 확인하세요.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setMode("edit")} className={darkMode ? "inline-flex items-center gap-2 rounded-2xl bg-white/10 px-4 py-3 font-bold active:scale-95" : "inline-flex items-center gap-2 rounded-2xl bg-slate-200 px-4 py-3 font-bold active:scale-95"}><ArrowLeft className="h-4 w-4" /> 편집</button>
              <button onClick={startPractice} className="rounded-2xl bg-yellow-300 px-4 py-3 font-black text-slate-950 active:scale-95">다시 연습</button>
            </div>
          </header>

          <section className="grid gap-4 sm:grid-cols-4">
            <ReportCard darkMode={darkMode} title="실제 발표 시간" value={formatTime(reportElapsedSeconds)} />
            <ReportCard darkMode={darkMode} title="목표 시간" value={formatTime(targetTimeSeconds)} />
            <ReportCard darkMode={darkMode} title={finalGap >= 0 ? "초과 시간" : "남은 여유"} value={formatTime(Math.abs(finalGap))} tone={finalGap > 0 ? "text-rose-400" : "text-emerald-400"} />
            <ReportCard darkMode={darkMode} title="평균 속도" value={`${averageUnitsPerSecond.toFixed(1)} 글자/초`} />
          </section>

          {recordings.length > 0 && (
            <section className={`${cardClass} mt-5 p-5 sm:p-6`}>
              <div className="mb-4 flex items-center gap-2"><Volume2 className="h-5 w-5" /><h2 className="text-xl font-bold">발표 녹음</h2></div>
              <div className="space-y-3">
                {recordings.map((recording) => <div key={recording.id} className={darkMode ? "rounded-2xl bg-white/10 p-4" : "rounded-2xl bg-slate-100 p-4"}><p className="mb-2 text-sm font-bold">{new Date(recording.createdAt).toLocaleString("ko-KR")} · {formatTime(recording.seconds)} · {recording.extension || "audio"}</p><audio controls src={recording.url} className="w-full" /></div>)}
              </div>
            </section>
          )}

          <section className={`${cardClass} mt-5 p-5 sm:p-6`}>
            <div className="mb-4 flex items-center gap-2"><BarChart3 className="h-5 w-5" /><h2 className="text-xl font-bold">다시 연습하면 좋은 문장</h2></div>
            <div className="grid gap-3 md:grid-cols-3">
              {slowStats.map((item) => <div key={item.index} className={darkMode ? "rounded-2xl bg-black/25 p-4" : "rounded-2xl bg-slate-100 p-4"}><p className="mb-2 text-sm font-bold">{item.index + 1}번 · {item.section} · {item.status}</p><p className={darkMode ? "text-sm leading-relaxed text-slate-300" : "text-sm leading-relaxed text-slate-600"}>{item.sentence}</p><p className="mt-3 text-sm">실제 {formatTime(item.actual)} · 권장 {formatTime(item.recommended)}</p></div>)}
            </div>
          </section>

          <section className={`${cardClass} mt-5 p-5 sm:p-6`}>
            <h2 className="mb-4 text-xl font-bold">문장별 속도 리포트</h2>
            <div className="space-y-3">
              {fullStats.map((item) => <div key={item.index} className={darkMode ? "rounded-2xl bg-white/10 p-4" : "rounded-2xl bg-slate-100 p-4"}><div className="mb-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-yellow-300 px-3 py-1 text-xs font-black text-slate-950">{item.index + 1}</span><span className="rounded-full bg-white/10 px-3 py-1 text-xs">{item.section}</span>{item.important && <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-xs font-black text-slate-950"><Star className="h-3 w-3 fill-current" /> 핵심</span>}<span className="rounded-full bg-white/10 px-3 py-1 text-xs">{item.status}</span><span className="text-sm">실제 {formatTime(item.actual)} / 권장 {formatTime(item.recommended)}</span></div><p className={darkMode ? "text-sm leading-relaxed text-slate-300" : "text-sm leading-relaxed text-slate-600"}>{item.sentence}</p></div>)}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={appClass}>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-yellow-300 px-4 py-2 text-sm font-bold text-slate-950"><FileText className="h-4 w-4" /> 발표프롬프트 앱</div>
            <h1 className="text-3xl font-black tracking-tight sm:text-5xl">발표 대본 연습 앱</h1>
            <p className={darkMode ? "mt-3 max-w-2xl text-slate-300" : "mt-3 max-w-2xl text-slate-600"}>대본 강조, 제한시간, 결과 리포트, 녹음, 실전 모드, 태블릿 발표자 노트까지 한 번에 연습할 수 있습니다.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {user ? (
              <>
                <span className={darkMode ? "inline-flex max-w-[180px] items-center gap-2 truncate rounded-xl bg-white/10 px-3 py-2 text-xs font-bold text-slate-200" : "inline-flex max-w-[180px] items-center gap-2 truncate rounded-xl bg-slate-200 px-3 py-2 text-xs font-bold text-slate-700"}><User className="h-3.5 w-3.5 shrink-0" /> {user.email}</span>
                <button onClick={handleSignOut} className={darkMode ? "inline-flex items-center gap-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-bold active:scale-95" : "inline-flex items-center gap-1 rounded-xl bg-slate-200 px-3 py-2 text-xs font-bold active:scale-95"}><LogOut className="h-3.5 w-3.5" /> 로그아웃</button>
              </>
            ) : (
              <>
                <button onClick={() => openAuthDialog("signin")} className={darkMode ? "rounded-xl bg-white/10 px-3 py-2 text-xs font-bold active:scale-95" : "rounded-xl bg-slate-200 px-3 py-2 text-xs font-bold active:scale-95"}>로그인</button>
                <button onClick={() => openAuthDialog("signup")} className="rounded-xl bg-yellow-300 px-3 py-2 text-xs font-black text-slate-950 active:scale-95">회원가입</button>
              </>
            )}
            <button onClick={() => setDarkMode((prev) => !prev)} className={darkMode ? "rounded-xl bg-white/10 p-2.5 active:scale-95" : "rounded-xl bg-slate-200 p-2.5 active:scale-95"} aria-label="화면 모드 변경">{darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
          </div>
        </header>

        <AnimatePresence>
          {authDialogOpen && (
            <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setAuthDialogOpen(false)}>
              <motion.section role="dialog" aria-modal="true" aria-labelledby="auth-title" className={darkMode ? "w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-5 shadow-2xl shadow-black/50 sm:p-6" : "w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-400/30 sm:p-6"} initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} onMouseDown={(event) => event.stopPropagation()}>
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <h2 id="auth-title" className="text-2xl font-black">{authMode === "signin" ? "로그인" : "회원가입"}</h2>
                    <p className={darkMode ? "mt-1 text-sm text-slate-400" : "mt-1 text-sm text-slate-500"}>대본과 녹음을 계정에 저장합니다.</p>
                  </div>
                  <button onClick={() => setAuthDialogOpen(false)} className={darkMode ? "rounded-xl bg-white/10 p-2 active:scale-95" : "rounded-xl bg-slate-100 p-2 active:scale-95"} aria-label="인증 창 닫기"><X className="h-4 w-4" /></button>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2">
                  <ModeButton active={authMode === "signin"} onClick={() => setAuthMode("signin")} label="로그인" />
                  <ModeButton active={authMode === "signup"} onClick={() => setAuthMode("signup")} label="회원가입" />
                </div>

                <button type="button" onClick={handleGoogleSignIn} className={darkMode ? "mb-3 inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white px-4 py-3 font-bold text-slate-950 active:scale-[0.99]" : "mb-3 inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 font-bold text-slate-950 shadow-sm active:scale-[0.99]"}>
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 text-sm font-black text-blue-600">G</span>
                  Google로 계속하기
                </button>

                <form onSubmit={handleAuthSubmit} className="space-y-3">
                  <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} className={darkMode ? "w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-yellow-300" : "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-yellow-400"} placeholder="이메일" autoComplete="email" required />
                  <input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} className={darkMode ? "w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-yellow-300" : "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-yellow-400"} placeholder="비밀번호" autoComplete={authMode === "signin" ? "current-password" : "new-password"} required minLength={6} />
                  <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-yellow-300 px-4 py-3 font-black text-slate-950 active:scale-[0.99]"><LogIn className="h-4 w-4" /> {authMode === "signin" ? "이메일로 로그인" : "계정 만들기"}</button>
                </form>

                {!isSupabaseConfigured && <p className="mt-3 text-xs text-rose-300">Supabase 환경변수를 설정해야 로그인할 수 있습니다.</p>}
                {(authStatus || cloudStatus) && <p className={darkMode ? "mt-3 text-xs text-slate-400" : "mt-3 text-xs text-slate-500"}>{authStatus || cloudStatus}</p>}
              </motion.section>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid gap-5 lg:grid-cols-[1.4fr_0.9fr]">
          <section className={`${cardClass} p-5 sm:p-7`}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div><h2 className="text-xl font-bold">1. 대본 입력</h2><p className={darkMode ? "mt-1 text-sm text-slate-400" : "mt-1 text-sm text-slate-500"}>파트 제목은 # 도입 또는 [도입]처럼 입력하면 자동으로 구간이 나뉩니다.</p></div>
              <button onClick={saveCurrentProject} className="inline-flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-bold text-white active:scale-95"><Save className="h-4 w-4" /> 저장</button>
            </div>

            <label className="mb-2 block text-sm font-semibold">발표 제목</label>
            <input value={title} onChange={(event) => setTitle(event.target.value)} className={darkMode ? "mb-4 w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-yellow-300" : "mb-4 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-yellow-400"} placeholder="예: 신규 서비스 발표" />

            <label className="mb-2 block text-sm font-semibold">발표 대본</label>
            <textarea value={script} onChange={(event) => { setScript(event.target.value); setSentenceItems([]); }} className={darkMode ? "min-h-[360px] w-full resize-y rounded-2xl border border-white/10 bg-black/30 px-4 py-4 leading-relaxed outline-none focus:border-yellow-300" : "min-h-[360px] w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-4 leading-relaxed outline-none focus:border-yellow-400"} placeholder="여기에 발표 대본을 붙여넣으세요." />

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button onClick={prepareSentences} className={darkMode ? "flex-1 rounded-2xl bg-white/10 px-5 py-4 font-bold active:scale-[0.99]" : "flex-1 rounded-2xl bg-slate-200 px-5 py-4 font-bold active:scale-[0.99]"}>문장 자동 분리</button>
              <button onClick={startPractice} className="flex-1 rounded-2xl bg-yellow-300 px-5 py-4 text-lg font-black text-slate-950 shadow-lg shadow-yellow-500/20 active:scale-[0.99]">발표 연습 시작</button>
            </div>
          </section>

          <aside className="space-y-5">
            <section className={`${cardClass} p-5 sm:p-6`}>
              <div className="mb-4 flex items-center gap-2"><Settings className="h-5 w-5" /><h2 className="text-xl font-bold">2. 연습 설정</h2></div>
              <div className="space-y-5">
                <div className={darkMode ? "rounded-2xl bg-white/10 p-4" : "rounded-2xl bg-slate-100 p-4"}>
                  <div className="mb-3 flex items-center gap-2"><Clock className="h-5 w-5" /><span className="font-semibold">발표 제한시간</span></div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm">분<input type="number" min="0" max="180" value={targetMinutes} onChange={(event) => setTargetMinutes(Math.max(0, Number(event.target.value)))} className={darkMode ? "mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 outline-none focus:border-yellow-300" : "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-yellow-400"} /></label>
                    <label className="text-sm">초<input type="number" min="0" max="59" value={targetSeconds} onChange={(event) => setTargetSeconds(Math.min(59, Math.max(0, Number(event.target.value))))} className={darkMode ? "mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 outline-none focus:border-yellow-300" : "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-yellow-400"} /></label>
                  </div>
                  <p className={darkMode ? "mt-3 text-xs text-slate-400" : "mt-3 text-xs text-slate-500"}>현재 예상 시간 {formatTime(timeSuggestion.estimatedSeconds)} · 목표 {formatTime(targetTimeSeconds)}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <ModeButton active={stageLayout === "coach"} onClick={() => setStageLayout("coach")} icon={<BarChart3 className="h-4 w-4" />} label="연습" />
                  <ModeButton active={stageLayout === "live"} onClick={() => setStageLayout("live")} icon={<MonitorSmartphone className="h-4 w-4" />} label="실전" />
                  <ModeButton active={stageLayout === "notes"} onClick={() => setStageLayout("notes")} icon={<StickyNote className="h-4 w-4" />} label="노트" />
                </div>

                <label className={darkMode ? "flex cursor-pointer items-center justify-between rounded-2xl bg-white/10 p-4" : "flex cursor-pointer items-center justify-between rounded-2xl bg-slate-100 p-4"}><span className="font-semibold">발표 녹음 저장</span><input type="checkbox" checked={recordEnabled} onChange={(event) => setRecordEnabled(event.target.checked)} className="h-5 w-5" /></label>
                {recordingStatus !== "idle" && <p className={darkMode ? "text-xs text-slate-400" : "text-xs text-slate-500"}>녹음 상태: {recordingStatus === "recording" ? "녹음 중" : recordingStatus === "saved" ? "저장됨" : recordingStatus === "blocked" ? "마이크 권한 필요" : "지원 제한"}</p>}

                <div><div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold">자동 넘김 기준</span><span>{Math.round(threshold * 100)}%</span></div><input type="range" min="0.55" max="0.9" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} className="w-full" /></div>
                <label className={darkMode ? "flex cursor-pointer items-center justify-between rounded-2xl bg-white/10 p-4" : "flex cursor-pointer items-center justify-between rounded-2xl bg-slate-100 p-4"}><span className="font-semibold">음성 인식 자동 넘김</span><input type="checkbox" checked={autoAdvance} onChange={(event) => setAutoAdvance(event.target.checked)} className="h-5 w-5" /></label>
              </div>
            </section>

            <section className={`${cardClass} p-5 sm:p-6`}>
              <div className="mb-4 flex items-center gap-2"><SlidersHorizontal className="h-5 w-5" /><h2 className="text-xl font-bold">발표 화면 꾸미기</h2></div>
              <div className="space-y-4">
                <div><p className="mb-2 text-sm font-semibold">화면 테마</p><div className="grid grid-cols-3 gap-2"><ModeButton active={practiceTheme === "dark"} onClick={() => setPracticeTheme("dark")} label="다크" /><ModeButton active={practiceTheme === "paper"} onClick={() => setPracticeTheme("paper")} label="종이" /><ModeButton active={practiceTheme === "blue"} onClick={() => setPracticeTheme("blue")} label="블루" /></div></div>
                <div><p className="mb-2 text-sm font-semibold">강조 스타일</p><div className="grid grid-cols-3 gap-2"><ModeButton active={highlightStyle === "karaoke"} onClick={() => setHighlightStyle("karaoke")} label="노래방" /><ModeButton active={highlightStyle === "underline"} onClick={() => setHighlightStyle("underline")} label="밑줄" /><ModeButton active={highlightStyle === "box"} onClick={() => setHighlightStyle("box")} label="박스" /></div></div>
                <div><div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold">글자 크기</span><span>{fontSize}px</span></div><input type="range" min="24" max="64" step="2" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} className="w-full" /></div>
                <div><div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold">줄 간격</span><span>{lineHeight.toFixed(2)}</span></div><input type="range" min="1.25" max="2" step="0.05" value={lineHeight} onChange={(event) => setLineHeight(Number(event.target.value))} className="w-full" /></div>
                <label className="flex items-center justify-between text-sm"><span>이전/다음 문장 표시</span><input type="checkbox" checked={showNextSentence} onChange={(event) => setShowNextSentence(event.target.checked)} /></label>
                <label className="flex items-center justify-between text-sm"><span>실시간 인식 내용 표시</span><input type="checkbox" checked={showTranscriptBox} onChange={(event) => setShowTranscriptBox(event.target.checked)} /></label>
                <label className="flex items-center justify-between text-sm"><span>시간 코치 표시</span><input type="checkbox" checked={showTimeCoach} onChange={(event) => setShowTimeCoach(event.target.checked)} /></label>
              </div>
            </section>

            <section className={`${cardClass} p-5 sm:p-6`}>
              <div className="mb-4 flex items-center gap-2"><Sparkles className="h-5 w-5 text-yellow-300" /><h2 className="text-xl font-bold">시간 맞춤 대본 제안</h2></div>
              <p className="font-bold">{timeSuggestion.title}</p>
              <div className="mt-3 space-y-2">{timeSuggestion.tips.map((tip, index) => <p key={index} className={darkMode ? "text-sm text-slate-300" : "text-sm text-slate-600"}>• {tip}</p>)}</div>
              {timeSuggestion.candidateIndexes.length > 0 && <div className={darkMode ? "mt-4 rounded-2xl bg-black/25 p-4" : "mt-4 rounded-2xl bg-slate-100 p-4"}><p className="mb-2 text-sm font-bold">줄이면 좋은 후보 문장</p><div className="space-y-2">{timeSuggestion.candidateIndexes.map((index) => <p key={index} className={darkMode ? "text-sm text-slate-300" : "text-sm text-slate-600"}>{index + 1}. {activeSentences[index]}</p>)}</div></div>}
              {timeSuggestion.suggestedScript && <div className="mt-4 flex flex-col gap-2 sm:flex-row"><button onClick={applySuggestedScript} className="flex-1 rounded-2xl bg-yellow-300 px-4 py-3 font-black text-slate-950 active:scale-95">제안 대본 적용</button><button onClick={copySuggestedScript} className={darkMode ? "inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white/10 px-4 py-3 font-bold active:scale-95" : "inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-200 px-4 py-3 font-bold active:scale-95"}><Copy className="h-4 w-4" /> {copyState === "done" ? "복사됨" : "복사"}</button></div>}
            </section>

            <section className={`${cardClass} p-5 sm:p-6`}>
              <h2 className="mb-4 text-xl font-bold">기기 상태</h2>
              <div className="space-y-3">
                <StatusRow darkMode={darkMode} ok={supportStatus === "supported"} title="브라우저 음성 인식" description={supportStatus === "supported" ? "사용 가능합니다. 시작 시 마이크 권한을 허용하세요." : supportStatus === "permission-denied" ? "마이크 권한이 차단되었습니다. 브라우저 설정에서 허용하세요." : "현재 브라우저에서 제한될 수 있습니다. Chrome 계열 브라우저를 권장합니다."} />
                <StatusRow darkMode={darkMode} ok={wakeLockStatus === "on"} title="화면 꺼짐 방지" description={wakeLockStatus === "on" ? "발표 중 화면 꺼짐 방지가 켜졌습니다." : "연습 시작 후 지원 기기에서 자동으로 시도합니다."} />
              </div>
            </section>

            <section className={`${cardClass} p-5 sm:p-6`}>
              <h2 className="mb-4 text-xl font-bold">저장한 대본</h2>
              {projects.length === 0 ? <p className={darkMode ? "text-sm text-slate-400" : "text-sm text-slate-500"}>아직 저장된 대본이 없습니다.</p> : <div className="space-y-2">{projects.map((project) => <div key={project.id} className={darkMode ? "flex items-center gap-2 rounded-2xl bg-white/10 p-3" : "flex items-center gap-2 rounded-2xl bg-slate-100 p-3"}><button onClick={() => loadProject(project.id)} className="min-w-0 flex-1 text-left"><p className="truncate font-semibold">{project.title}</p><p className={darkMode ? "text-xs text-slate-400" : "text-xs text-slate-500"}>{new Date(project.updatedAt).toLocaleString("ko-KR")}</p></button><button onClick={() => deleteProject(project.id)} className="rounded-xl p-2 text-rose-400 active:scale-95" aria-label="대본 삭제"><Trash2 className="h-4 w-4" /></button></div>)}</div>}
            </section>

            <section className={`${cardClass} p-5 sm:p-6`}>
              <div className="mb-4 flex items-center gap-2"><Volume2 className="h-5 w-5" /><h2 className="text-xl font-bold">저장한 녹음</h2></div>
              {recordings.length === 0 ? <p className={darkMode ? "text-sm text-slate-400" : "text-sm text-slate-500"}>아직 저장된 녹음이 없습니다.</p> : <div className="space-y-3">{recordings.map((recording) => <div key={recording.id} className={darkMode ? "rounded-2xl bg-white/10 p-4" : "rounded-2xl bg-slate-100 p-4"}><p className="mb-2 truncate text-sm font-bold">{recording.title} · {formatTime(recording.seconds)} · {recording.extension || "audio"}</p><p className={darkMode ? "mb-2 text-xs text-slate-400" : "mb-2 text-xs text-slate-500"}>{new Date(recording.createdAt).toLocaleString("ko-KR")}{recording.cloud ? " · 클라우드" : " · 이 기기"}</p>{recording.url ? <audio controls src={recording.url} className="w-full" /> : <p className="text-xs text-rose-300">재생 URL을 만들 수 없습니다.</p>}</div>)}</div>}
            </section>
          </aside>
        </div>

        {activeItems.length > 0 && (
          <section className={`${cardClass} mt-5 p-5 sm:p-6`}>
            <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Layers className="h-5 w-5" /><h2 className="text-xl font-bold">문장 분리 결과 · 파트 구조 · 핵심 표시</h2></div><span className={darkMode ? "rounded-full bg-white/10 px-3 py-1 text-sm text-slate-300" : "rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600"}>총 {activeItems.length}문장</span></div>
            <div className="mb-5 flex flex-wrap gap-2">{sectionSummary.map((section) => <span key={section.name} className="rounded-full bg-yellow-300 px-3 py-1 text-xs font-black text-slate-950">{section.name} · {section.count}</span>)}</div>
            <ol className="grid gap-3 md:grid-cols-2">
              {activeItems.map((item, index) => {
                const recommended = Math.max(3, Math.round(((countSpeechUnits(item.text) || 1) / totalSpeechUnits) * targetTimeSeconds));
                const isCandidate = timeSuggestion.candidateIndexes.includes(index);
                return <li key={`${item.text}-${index}`} className={darkMode ? "rounded-2xl bg-black/25 p-4 text-sm leading-relaxed text-slate-200" : "rounded-2xl bg-slate-100 p-4 text-sm leading-relaxed text-slate-700"}><div className="mb-2 flex flex-wrap items-center gap-2"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-yellow-300 text-xs font-black text-slate-950">{index + 1}</span><span className="rounded-full bg-white/10 px-3 py-1 text-xs">{item.section}</span><button onClick={() => toggleImportant(index)} className={importantMap[index] ? "inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-xs font-black text-slate-950" : "inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs"}><Star className={importantMap[index] ? "h-3 w-3 fill-current" : "h-3 w-3"} /> 핵심</button><span className="rounded-full bg-white/10 px-3 py-1 text-xs">권장 {formatTime(recommended)}</span>{isCandidate && <span className="rounded-full bg-rose-500 px-3 py-1 text-xs font-bold text-white">줄이기 후보</span>}</div>{item.text}</li>;
              })}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function MetricCard({ title, value, sub, valueClass = "" }) {
  return <div className="rounded-3xl border border-white/10 bg-white/5 p-4"><p className="text-sm text-slate-400">{title}</p><p className={`mt-1 text-2xl font-bold ${valueClass}`}>{value}</p>{sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}</div>;
}

function ReportCard({ darkMode, title, value, tone = "" }) {
  return <div className={darkMode ? "rounded-3xl border border-white/10 bg-white/8 p-5" : "rounded-3xl border border-slate-200 bg-white p-5 shadow"}><p className={darkMode ? "text-sm text-slate-400" : "text-sm text-slate-500"}>{title}</p><p className={`mt-2 text-2xl font-black ${tone}`}>{value}</p></div>;
}

function StatusRow({ darkMode, ok, title, description }) {
  return <div className={darkMode ? "flex gap-3 rounded-2xl bg-white/10 p-4" : "flex gap-3 rounded-2xl bg-slate-100 p-4"}>{ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" /> : <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />}<div><p className="font-semibold">{title}</p><p className={darkMode ? "mt-1 text-sm text-slate-400" : "mt-1 text-sm text-slate-500"}>{description}</p></div></div>;
}

function ModeButton({ active, onClick, icon, label }) {
  return <button type="button" onClick={onClick} className={active ? "inline-flex items-center justify-center gap-2 rounded-2xl bg-yellow-300 px-3 py-3 text-sm font-black text-slate-950 active:scale-95" : "inline-flex items-center justify-center gap-2 rounded-2xl bg-white/10 px-3 py-3 text-sm font-bold active:scale-95"}>{icon}{label}</button>;
}

function NoteLine({ label, text, strong, dim }) {
  return <div className={strong ? "rounded-2xl bg-yellow-300 p-4 text-slate-950" : "rounded-2xl bg-white/10 p-4"}><p className={strong ? "mb-1 text-xs font-black text-slate-700" : "mb-1 text-xs text-slate-400"}>{label}</p><p className={dim ? "text-sm leading-relaxed text-slate-400" : strong ? "text-base font-black leading-relaxed" : "text-sm leading-relaxed"}>{text}</p></div>;
}
