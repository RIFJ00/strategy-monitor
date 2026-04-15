/**
 * 会議体ダッシュボード (回数取得・近接検索版)
 * [修正点]
 * 1. 近接検索ロジック: ページ全体ではなく、会議名が出現した場所の直後から情報を探索。
 * 2. 回数抽出: 「第〇回」という表記を抽出し、表示・保存に対応。
 * 3. 複数会議対応: 同一URL内でも会議名ごとに正しい日付を取得可能に。
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, query, doc, updateDoc, 
  serverTimestamp, writeBatch, getDoc, setDoc 
} from 'firebase/firestore';
import { 
  Search, CheckCircle, Clock, AlertTriangle, ExternalLink, 
  RefreshCw, Edit3, X, Database, PlayCircle, Loader2, Tag, Filter, 
  Save, UserCheck, WifiOff, CheckSquare, Square, StopCircle, 
  Play, RotateCcw, Eye, ArrowUpDown, EyeOff, Bookmark, MapPin, Power, Hash
} from 'lucide-react';

const myFirebaseConfig = {
  apiKey: "AIzaSyBx5e752GWfvJDZ3lEx0IcArxjvCEz7S2M",
  authDomain: "seisakuresearch00.firebaseapp.com",
  projectId: "seisakuresearch00",
  storageBucket: "seisakuresearch00.firebasestorage.app",
  messagingSenderId: "356788263577",
  appId: "1:356788263577:web:ecc3782d0c82cb7da43608"
};

const firebaseConfig = myFirebaseConfig;
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);
const db = getFirestore(app);

const TARGET_APP_ID = 'seisakuresearch';
const getMeetingsCol = () => collection(db, 'artifacts', TARGET_APP_ID, 'public', 'data', 'meetings');
const getMeetingDoc = (id) => doc(db, 'artifacts', TARGET_APP_ID, 'public', 'data', 'meetings', id);
const getSystemConfigDoc = () => doc(db, 'artifacts', TARGET_APP_ID, 'public', 'data', 'config', 'system');

// 日付パース用
const parseJapaneseDateToTs = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  try {
    const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/;
    const match = dateStr.match(dateRegex);
    if (!match) return 0;
    let year, month, day;
    const fullMatch = match[0];
    if (fullMatch.includes('令和')) {
      const reiwaYearStr = fullMatch.match(/令和\s*?(\d+|元)年/)[1];
      year = reiwaYearStr === '元' ? 2019 : 2018 + parseInt(reiwaYearStr, 10);
    } else {
      year = parseInt(fullMatch.match(/(\d{4})年/)[1], 10);
    }
    month = parseInt(fullMatch.match(/(\d{1,2})月/)[1], 10) - 1;
    day = parseInt(fullMatch.match(/(\d{1,2})日/)[1], 10);
    return new Date(year, month, day).getTime();
  } catch (e) { return 0; }
};

const formatToWestern = (dateStr) => {
  if (!dateStr) return '';
  const ts = parseJapaneseDateToTs(dateStr);
  if (ts === 0) return dateStr;
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

const MINISTRY_ORDER = [
  "内閣官房", "内閣府", "デジタル庁", "復興庁", "総務省", "法務省", "外務省", "財務省", 
  "文部科学省", "厚生労働省", "農林水産省", "経済産業省", "国土交通省", "環境省", "原子力規制委員会", "防衛省"
];

export default function App() {
  const [user, setUser] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [isAutoUpdateOn, setIsAutoUpdateOn] = useState(true);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState(null);
  
  const [statusFilter, setStatusFilter] = useState('all');
  const [fieldFilter, setFieldFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState('default'); 
  
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmBatch, setConfirmBatch] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [checkingId, setCheckingId] = useState(null); 
  
  const [isBulkChecking, setIsBulkChecking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [bulkCheckProgress, setBulkCheckProgress] = useState({ current: 0, total: 0 });
  const [queue, setQueue] = useState([]);

  const currentAbortController = useRef(null);

  useEffect(() => {
    const startAuth = async () => {
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
        const configSnap = await getDoc(getSystemConfigDoc());
        if (configSnap.exists()) {
          setIsAutoUpdateOn(configSnap.data().autoUpdateEnabled ?? true);
        } else {
          await setDoc(getSystemConfigDoc(), { autoUpdateEnabled: true }, { merge: true });
        }
      } catch (e) { setInitError(`接続エラー: ${e.message}`); }
    };
    startAuth();
    return onAuthStateChanged(auth, (u) => { setUser(u); if (u) setInitError(null); });
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsubscribe = onSnapshot(query(getMeetingsCol()), 
      (snapshot) => {
        const data = snapshot.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            meetingName: d['会議名'] || d.meetingName || '無題の会議',
            url: d['URL'] || d.url || '',
            agency: d['所管'] || d['省庁'] || d.agency || d['市内'] || '-',
            relatedField: d['関連分野'] || d.relatedField || '-',
            latestDateString: d['直近開催日'] || d.latestDateString || '',
            latestDateTimestamp: d.latestDateTimestamp || parseJapaneseDateToTs(d['直近開催日'] || d.latestDateString),
            previousDateString: d.previousDateString || '',
            meetingRound: d.meetingRound || '', // 追加：第〇回
            status: d.status || 'unchanged',
            isManual: d.isManual || false, 
            lastCheckedAt: d.lastCheckedAt,
            errorMessage: d.errorMessage || null,
            createdAt: d.createdAt || null
          };
        });
        setMeetings(data);
        setLoading(false);
      },
      (error) => { setLoading(false); }
    );
    return () => unsubscribe();
  }, [user]);

  // ソート・フィルタリング・サマリー計算は前回同様のため省略（ロジック維持）
  const baseSortedMeetings = useMemo(() => {
    return [...meetings].sort((a, b) => {
      const isUnreadA = a.status === 'updated';
      const isUnreadB = b.status === 'updated';
      if (isUnreadA && !isUnreadB) return -1;
      if (!isUnreadA && isUnreadB) return 1;
      const isErrorA = a.status === 'error';
      const isErrorB = b.status === 'error';
      if (isErrorA && !isErrorB) return -1;
      if (!isErrorA && isErrorB) return 1;
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (Number(a.createdAt) || 0);
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (Number(b.createdAt) || 0);
      return timeA - timeB;
    });
  }, [meetings]);

  const uniqueFields = useMemo(() => {
    const fields = [];
    baseSortedMeetings.forEach(m => {
      if (m.relatedField && m.relatedField !== '-' && !fields.includes(m.relatedField)) fields.push(m.relatedField);
    });
    return fields;
  }, [baseSortedMeetings]);

  const uniqueAgencies = useMemo(() => {
    const rawAgencies = Array.from(new Set(meetings.map(m => m.agency).filter(a => a && a !== '-')));
    return rawAgencies.sort((a, b) => {
      const indexA = MINISTRY_ORDER.indexOf(a);
      const indexB = MINISTRY_ORDER.indexOf(b);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.localeCompare(b, 'ja');
    });
  }, [meetings]);

  const filteredAndSortedMeetings = useMemo(() => {
    let result = meetings.filter(m => {
      const matchesField = fieldFilter === 'all' ? true : m.relatedField === fieldFilter;
      const matchesAgency = agencyFilter === 'all' ? true : m.agency === agencyFilter;
      const q = searchQuery.toLowerCase();
      const matchesSearch = (m.meetingName || "").toLowerCase().includes(q);
      const filterByStatus = () => {
        if (statusFilter === 'all') return true;
        if (statusFilter === 'updated') return m.status === 'updated' && !m.isManual;
        if (statusFilter === 'manual') return m.status === 'updated' && m.isManual;
        return m.status === statusFilter;
      };
      return matchesField && matchesAgency && matchesSearch && filterByStatus();
    });

    return result.sort((a, b) => {
      if (sortMode === 'name') return a.meetingName.localeCompare(b.meetingName, 'ja');
      const isUnreadA = a.status === 'updated';
      const isUnreadB = b.status === 'updated';
      if (isUnreadA && !isUnreadB) return -1;
      if (!isUnreadA && isUnreadB) return 1;
      const isErrorA = a.status === 'error';
      const isErrorB = b.status === 'error';
      if (isErrorA && !isErrorB) return -1;
      if (!isErrorA && isErrorB) return 1;
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (Number(a.createdAt) || 0);
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (Number(b.createdAt) || 0);
      return timeA - timeB;
    });
  }, [meetings, statusFilter, fieldFilter, agencyFilter, searchQuery, sortMode]);

  const executeCheck = async (meeting) => {
    if (!meeting.url || !user) return;
    setCheckingId(meeting.id);
    currentAbortController.current = new AbortController();
    const timeoutId = setTimeout(() => currentAbortController.current?.abort(), 45000);
    try {
      const fetchWithProxy = async (url, signal) => {
        const proxies = [
          { url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, type: 'json' },
          { url: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`, type: 'text' }
        ];
        for (const proxy of proxies) {
          try {
            const res = await fetch(proxy.url(url), { signal });
            if (!res.ok) continue;
            return proxy.type === 'json' ? (await res.json()).contents : await res.text();
          } catch (e) { if (e.name === 'AbortError') throw e; }
        }
        throw new Error("Proxy Error");
      };

      const html = await fetchWithProxy(meeting.url, currentAbortController.current.signal);
      clearTimeout(timeoutId);

      // --- 近接探索ロジックの開始 ---
      // 1. HTML内の会議名の位置を探す（タグを除去したプレーンテキストで実施）
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const plainText = tempDiv.innerText || tempDiv.textContent;
      
      const meetingIndex = plainText.indexOf(meeting.meetingName);
      if (meetingIndex === -1) {
        throw new Error("会議名が見つかりません");
      }

      // 2. 会議名の直後（例えば500文字以内）を探索対象にする
      const searchText = plainText.substring(meetingIndex, meetingIndex + 800);

      // 3. 探索対象の中から「日付」と「回数」を探す
      const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/g;
      const roundRegex = /第\s*?(\d+|元)\s*?回/g;

      let match;
      let foundDateTs = 0;
      let foundDateStr = '';
      let foundRound = '';

      // 直近の日付を1つ取得
      if ((match = dateRegex.exec(searchText)) !== null) {
        foundDateTs = parseJapaneseDateToTs(match[0]);
        foundDateStr = match[0];
      }

      // 回数（第〇回）を1つ取得
      const roundMatch = roundRegex.exec(searchText);
      if (roundMatch) {
        foundRound = roundMatch[0];
      }

      const westernStr = formatToWestern(foundDateStr);
      const registeredTs = meeting.latestDateTimestamp || 0;
      
      let updatePayload = { lastCheckedAt: serverTimestamp(), errorMessage: null };
      
      if (foundDateTs > registeredTs) {
        updatePayload.latestDateString = westernStr;
        updatePayload.latestDateTimestamp = foundDateTs;
        updatePayload.previousDateString = meeting.latestDateString;
        updatePayload.meetingRound = foundRound; // 回数を保存
        updatePayload.status = 'updated';
        updatePayload.isManual = false; 
        updatePayload['直近開催日'] = westernStr;
      } else {
        // 日付が変わっていなくても、回数が取れていて前のと違えば更新（任意）
        if (foundRound && foundRound !== meeting.meetingRound) {
           updatePayload.meetingRound = foundRound;
        }
      }
      
      await updateDoc(getMeetingDoc(meeting.id), updatePayload);
    } catch (e) {
      if (e.name !== 'AbortError') {
        await updateDoc(getMeetingDoc(meeting.id), { 
          status: 'error', 
          errorMessage: e.message || "通信失敗", 
          lastCheckedAt: serverTimestamp() 
        });
      }
    } finally { 
      setCheckingId(null); 
      clearTimeout(timeoutId); 
      currentAbortController.current = null; 
    }
  };

  const toggleAutoUpdate = async () => {
    const newVal = !isAutoUpdateOn;
    setIsAutoUpdateOn(newVal);
    try {
      await setDoc(getSystemConfigDoc(), { autoUpdateEnabled: newVal, lastModifiedAt: serverTimestamp() }, { merge: true });
    } catch (e) { alert("設定保存失敗"); }
  };

  const handleBulkStart = (targets) => {
    setConfirmBatch(null); setIsBulkChecking(true); setIsPaused(false);
    setBulkCheckProgress({ current: 0, total: targets.length });
    setQueue([...targets]);
  };

  useEffect(() => {
    if (!isBulkChecking || isPaused || queue.length === 0) return;
    const processNext = async () => {
      await executeCheck(queue[0]);
      if (!isPaused) {
        setQueue(prev => {
          const next = prev.slice(1);
          if (next.length === 0) { setIsBulkChecking(false); setSelectedIds(new Set()); }
          return next;
        });
        setBulkCheckProgress(prev => ({ ...prev, current: prev.current + 1 }));
      }
    };
    const timer = setTimeout(processNext, 1200);
    return () => clearTimeout(timer);
  }, [isBulkChecking, isPaused, queue]);

  const handleMarkAllRead = async () => {
    const targets = meetings.filter(m => m.status === 'updated');
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length} 件の通知をすべて既読にしますか？`)) return;
    const batch = writeBatch(db);
    targets.forEach(m => batch.update(getMeetingDoc(m.id), { status: 'unchanged', isManual: false, previousDateString: "" }));
    await batch.commit();
  };

  const handleToggleStatus = async (meeting) => {
    if (!user) return;
    if (meeting.status === 'updated') {
      await updateDoc(getMeetingDoc(meeting.id), { status: 'unchanged', isManual: false, previousDateString: "" });
    } else {
      await updateDoc(getMeetingDoc(meeting.id), { status: 'updated', isManual: true });
    }
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editTarget || !user) return;
    setIsSaving(true);
    try {
      const normalizedDate = formatToWestern(editTarget.latestDateString);
      const newTs = parseJapaneseDateToTs(normalizedDate);
      await updateDoc(getMeetingDoc(editTarget.id), {
        '直近開催日': normalizedDate, latestDateString: normalizedDate, latestDateTimestamp: newTs,
        status: 'unchanged', isManual: false, errorMessage: null, lastModifiedAt: serverTimestamp()
      });
      setEditTarget(null);
    } catch (e) { alert("保存失敗"); } finally { setIsSaving(false); }
  };

  const summary = {
    total: meetings.length,
    updated: meetings.filter(m => m.status === 'updated' && !m.isManual).length,
    manual: meetings.filter(m => m.status === 'updated' && m.isManual).length,
    unchanged: meetings.filter(m => m.status === 'unchanged').length,
    error: meetings.filter(m => m.status === 'error').length
  };

  const formatCheckTime = (ts) => {
    if (!ts) return '-';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 font-sans text-gray-900">
      <div className="max-w-7xl mx-auto space-y-4">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-5 rounded-3xl shadow-sm border border-gray-100">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <div>
              <h1 className="text-xl font-black flex items-center gap-3 text-gray-900 leading-none">
                <div className="p-2 bg-indigo-600 rounded-xl text-white shadow-lg"><Database className="w-5 h-5" /></div>
                Strategy Monitor
              </h1>
              <div className="mt-2 flex items-center gap-3 opacity-70">
                <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full ${user ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} text-[9px] font-black uppercase tracking-wider`}>
                  {user ? <UserCheck className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {user ? `READY` : 'OFFLINE'}
                </div>
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest px-1">Daily Live Update</p>
              </div>
            </div>

            <div className="flex items-center gap-3 bg-gray-50 px-4 py-2.5 rounded-2xl border border-gray-100 shadow-inner">
              <div className={`p-2 rounded-xl ${isAutoUpdateOn ? 'bg-green-500 text-white' : 'bg-gray-300 text-white'} transition-colors`}><Power className="w-4 h-4" /></div>
              <div className="flex flex-col">
                <span className="text-[9px] font-black text-gray-400 uppercase tracking-tighter leading-none mb-1">Daily Auto Update</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-black ${isAutoUpdateOn ? 'text-green-600' : 'text-gray-400'}`}>{isAutoUpdateOn ? '稼働中' : '停止中'}</span>
                  <button onClick={toggleAutoUpdate} className={`relative w-10 h-5 rounded-full transition-colors duration-300 ${isAutoUpdateOn ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform duration-300 ${isAutoUpdateOn ? 'translate-x-5' : 'translate-x-0'}`}></div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 md:mt-0 flex flex-wrap gap-2">
            {(summary.updated + summary.manual) > 0 && (
              <button onClick={handleMarkAllRead} className="flex items-center gap-2 px-5 py-2.5 bg-gray-100 text-gray-600 rounded-2xl font-black shadow-sm text-sm active:scale-95 hover:bg-gray-200 border border-gray-200 transition-all">
                <Eye className="w-5 h-5" /> 全て既読にする
              </button>
            )}
            <button 
              onClick={() => setConfirmBatch({ targets: selectedIds.size > 0 ? meetings.filter(m => selectedIds.has(m.id)) : filteredAndSortedMeetings })} 
              disabled={isBulkChecking || !user || meetings.length === 0}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-2xl font-black shadow-lg transition-all active:scale-95 text-sm ${selectedIds.size > 0 ? 'bg-indigo-500 text-white animate-pulse' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100'}`}
            >
              {isBulkChecking ? <Loader2 className="w-5 h-5 animate-spin" /> : (selectedIds.size > 0 ? <CheckSquare className="w-5 h-5" /> : <RefreshCw className="w-5 h-5" />)}
              {selectedIds.size > 0 ? `選択分 (${selectedIds.size}) 更新` : '一括巡回 (毎日更新)'}
            </button>
          </div>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <button onClick={() => { setStatusFilter('all'); setSortMode('default'); setFieldFilter('all'); setAgencyFilter('all'); setSearchQuery(''); }} className={`p-4 rounded-[2rem] border bg-white text-left transition-all group ${statusFilter === 'all' && sortMode === 'default' ? `ring-4 ring-indigo-50 border-indigo-500 shadow-xl` : 'border-gray-100 hover:border-gray-200 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">総監視数 (リセット)</span>
            <span className="text-2xl font-black text-gray-900">{summary.total}</span>
          </button>
          <button onClick={() => setStatusFilter('updated')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all group ${statusFilter === 'updated' ? `ring-4 ring-red-50 border-red-500 shadow-xl` : 'border-gray-100 hover:border-gray-200 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-red-400">更新あり</span>
            <span className="text-2xl font-black text-red-600 animate-pulse">{summary.updated}</span>
          </button>
          <button onClick={() => setStatusFilter('manual')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all group ${statusFilter === 'manual' ? `ring-4 ring-blue-50 border-blue-500 shadow-xl` : 'border-gray-100 hover:border-gray-200 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-blue-400">チェック用</span>
            <span className="text-2xl font-black text-blue-600">{summary.manual}</span>
          </button>
          <button onClick={() => setStatusFilter('unchanged')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all group ${statusFilter === 'unchanged' ? `ring-4 ring-gray-100 border-gray-400 shadow-xl` : 'border-gray-100 hover:border-gray-200 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">変更なし</span>
            <span className="text-2xl font-black text-gray-900">{summary.unchanged}</span>
          </button>
          <button onClick={() => setStatusFilter('error')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all group ${statusFilter === 'error' ? `ring-4 ring-orange-50 border-orange-500 shadow-xl` : 'border-gray-100 hover:border-gray-200 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-orange-400">エラー/遅延</span>
            <span className="text-2xl font-black text-orange-600">{summary.error}</span>
          </button>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative group md:col-span-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="キーワード検索..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm text-sm font-bold focus:ring-2 focus:ring-indigo-50 outline-none" />
          </div>
          <div className="relative">
            <Filter className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={fieldFilter} onChange={e => setFieldFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm cursor-pointer outline-none">
              <option value="all">全ての分野</option>
              {uniqueFields.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="relative">
            <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={agencyFilter} onChange={e => setAgencyFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm cursor-pointer outline-none">
              <option value="all">全ての所管</option>
              {uniqueAgencies.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        {/* Main Table */}
        <div className="bg-white rounded-[2.5rem] shadow-xl border border-gray-100 overflow-hidden min-h-[450px]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="bg-gray-50/50 text-gray-400 font-black border-b border-gray-100 uppercase tracking-widest text-[9px]">
                <tr>
                  <th className="px-4 py-6 w-10 text-center">
                    <button onClick={() => {
                      if (selectedIds.size === filteredAndSortedMeetings.length) setSelectedIds(new Set());
                      else setSelectedIds(new Set(filteredAndSortedMeetings.map(m => m.id)));
                    }} className="p-1 hover:bg-gray-200 rounded transition-colors">
                      {selectedIds.size === filteredAndSortedMeetings.length && filteredAndSortedMeetings.length > 0 ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5 text-gray-300" />}
                    </button>
                  </th>
                  <th className="px-4 py-6 w-60 whitespace-nowrap">状態 / 巡回時間</th>
                  <th className="px-4 py-6 cursor-pointer hover:text-indigo-600" onClick={() => setSortMode(sortMode === 'name' ? 'default' : 'name')}>
                    <div className="flex items-center gap-1 font-black">会議体名 / 分野 / 所管 <ArrowUpDown className="w-3.5 h-3.5" /></div>
                  </th>
                  <th className="px-4 py-6 text-center w-64 text-gray-500 font-bold italic">開催日 (最新)</th>
                  <th className="px-8 py-6 text-right font-black">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 font-sans">
                {filteredAndSortedMeetings.map(m => (
                  <tr key={m.id} className={`group transition-all ${selectedIds.has(m.id) ? 'bg-indigo-50/30' : ''} ${m.status === 'updated' && !m.isManual ? 'bg-red-50/10' : ''} ${m.status === 'updated' && m.isManual ? 'bg-blue-50/5' : ''} ${m.status === 'error' ? 'bg-orange-50/10' : ''}`}>
                    <td className="px-4 py-3 align-middle text-center">
                       <button onClick={() => {
                         const newSelected = new Set(selectedIds);
                         if (newSelected.has(m.id)) newSelected.delete(m.id); else newSelected.add(m.id);
                         setSelectedIds(newSelected);
                       }} className="p-1 hover:bg-indigo-100 rounded transition-colors">
                         {selectedIds.has(m.id) ? <CheckSquare className="w-5 h-5 text-indigo-600" /> : <Square className="w-5 h-5 text-gray-200" />}
                       </button>
                    </td>
                    <td className="px-4 py-3 align-middle whitespace-nowrap">
                      <div className="flex flex-col gap-1.5 min-w-[210px] items-start">
                        {m.status === 'updated' ? (
                          <div className="flex flex-col gap-1.5 w-full items-start">
                            <div className="flex items-center gap-2">
                              <button onClick={() => handleToggleStatus(m)} className="px-3 py-1 bg-red-600 text-white text-[9px] font-black rounded-lg hover:bg-red-700 shadow-sm flex items-center gap-1 active:scale-95 transition-all">
                                <CheckCircle className="w-3 h-3" /> 既読にする
                              </button>
                              <span className="text-[7.5px] text-gray-400 font-bold opacity-80 uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <div className={`flex items-center gap-1.5 text-[8.5px] font-black px-2 py-0.5 rounded border leading-none w-fit ${m.isManual ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-red-50 text-red-600 border-red-200'}`}>
                               {m.isManual ? <Bookmark className="w-2.5 h-2.5 text-blue-500" /> : <RefreshCw className="w-2.5 h-2.5 animate-spin-slow text-red-500" />}
                               {m.isManual ? 'チェック用' : '未読（新着）'}
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5 w-full items-start">
                            <div className="flex items-center gap-2">
                              <div className={`flex items-center gap-1 text-[8.5px] font-black px-2 py-1 rounded-lg border leading-none ${m.status === 'error' ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                                 {m.status === 'error' ? <AlertTriangle className="w-2.5 h-2.5" /> : <CheckCircle className="w-2.5 h-2.5 text-gray-300" />}
                                 {m.status === 'error' ? 'エラー' : '変更なし'}
                              </div>
                              <span className="text-[7.5px] text-gray-400 font-bold uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <button onClick={() => handleToggleStatus(m)} className="flex items-center gap-1 px-2 py-0.5 bg-white text-indigo-400 hover:text-indigo-600 border border-indigo-50 hover:border-indigo-200 text-[8px] font-black rounded-md transition-all active:scale-95 w-fit shadow-sm">
                               <EyeOff className="w-2.5 h-2.5" /> 未読とする
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <div className="font-black text-gray-900 text-sm leading-tight line-clamp-1 group-hover:text-indigo-600 transition-colors">{m.meetingName}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-1 opacity-70">
                        <span className="flex items-center gap-1 text-[8px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 shadow-sm"><Tag className="w-2.5 h-2.5" /> {m.relatedField || '-'}</span>
                        <span className="flex items-center gap-1 text-[8px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 shadow-sm"><MapPin className="w-2.5 h-2.5" /> {m.agency}</span>
                        {/* 回数表示の追加 */}
                        {m.meetingRound && (
                          <span className="flex items-center gap-1 text-[8px] font-black text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded border border-orange-100 shadow-sm"><Hash className="w-2.5 h-2.5" /> {m.meetingRound}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle text-center">
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        {m.status === 'updated' && !m.isManual && m.previousDateString ? (
                          <><div className="text-xs font-black text-red-600 animate-pulse">{m.latestDateString}</div><div className="text-[10px] text-gray-400 font-bold opacity-70 leading-none">{m.previousDateString}</div></>
                        ) : (
                          <div className="text-xs font-bold text-gray-500">{m.latestDateString || '未定'}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-3 align-middle text-right">
                      <div className="flex justify-end items-center gap-1.5 opacity-30 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => executeCheck(m)} disabled={checkingId === m.id || !user || isBulkChecking} className="p-2 text-indigo-600 hover:bg-indigo-600 hover:text-white rounded-xl active:scale-90 shadow-sm border border-indigo-50 bg-white transition-all"><PlayCircle className="w-4 h-4" /></button>
                        <button onClick={() => setEditTarget(m)} disabled={isBulkChecking} className="p-2 text-blue-600 hover:bg-blue-600 hover:text-white rounded-xl active:scale-90 shadow-sm border border-blue-50 bg-white transition-all"><Edit3 className="w-4 h-4" /></button>
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-gray-50 rounded-xl transition-all border border-gray-100 bg-white shadow-sm"><ExternalLink className="w-4 h-4" /></a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 巡回パネル */}
      {isBulkChecking && (
        <div className="fixed bottom-8 right-8 bg-white p-8 rounded-[2.5rem] shadow-2xl border-2 border-indigo-50 z-50 w-80 animate-in slide-in-from-right-10">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-2xl shadow-inner ${isPaused ? 'bg-orange-50' : 'bg-indigo-50'}`}><RefreshCw className={`w-6 h-6 ${isPaused ? 'text-orange-600' : 'text-indigo-600 animate-spin'}`} /></div>
              <h3 className="font-black text-gray-900 leading-none text-sm">{isPaused ? '一時停止中' : '巡回中...'}</h3>
            </div>
            <div className="flex gap-1.5">
              {isPaused ? (
                <><button onClick={() => setIsPaused(false)} className="p-2.5 bg-green-50 text-green-600 rounded-xl active:scale-90 border border-green-100 shadow-sm"><Play className="w-4 h-4 fill-current" /></button><button onClick={() => { setIsBulkChecking(false); setQueue([]); }} className="p-2.5 bg-red-50 text-red-600 rounded-xl active:scale-90 border border-red-100 shadow-sm"><RotateCcw className="w-4 h-4" /></button></>
              ) : (
                <button onClick={() => setIsPaused(true)} className="p-2.5 bg-orange-50 text-orange-600 rounded-xl active:scale-90 border border-orange-100 shadow-sm"><StopCircle className="w-5 h-5 fill-current" /></button>
              )}
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-3 mb-4 overflow-hidden shadow-inner"><div className={`h-full transition-all duration-700 ${isPaused ? 'bg-orange-400' : 'bg-gradient-to-r from-indigo-500 to-indigo-700'}`} style={{ width: `${(bulkCheckProgress.current / bulkCheckProgress.total) * 100}%` }}></div></div>
          <div className="text-xl font-black text-gray-900 leading-none">{bulkCheckProgress.current} / {bulkCheckProgress.total} ({Math.round((bulkCheckProgress.current / bulkCheckProgress.total) * 100)}%)</div>
        </div>
      )}

      {/* モーダル類 */}
      {confirmBatch && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-8 text-center space-y-5 animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto shadow-inner"><RefreshCw className="w-8 h-8" /></div>
            <h3 className="text-xl font-black text-gray-900 tracking-tight leading-tight px-2">巡回チェックを開始しますか？</h3>
            <p className="text-xs text-gray-500 font-bold px-4 leading-relaxed">対象: <span className="text-indigo-600 text-base">{confirmBatch.targets.length}</span> 件の会議体</p>
            <div className="pt-4 flex gap-3"><button onClick={() => setConfirmBatch(null)} className="flex-1 py-4 bg-gray-100 text-gray-400 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs uppercase">戻る</button><button onClick={() => handleBulkStart(confirmBatch.targets)} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition-all active:scale-95 text-xs uppercase">実行する</button></div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 border border-gray-100 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6"><h2 className="font-black text-gray-900 flex items-center gap-2 text-base leading-none"><Edit3 className="w-5 h-5 text-blue-600" /> 日付の修正</h2><button onClick={() => setEditTarget(null)} className="p-2 text-gray-400 hover:bg-gray-200 rounded-full transition-all"><X className="w-5 h-5" /></button></div>
            <form onSubmit={handleSaveEdit} className="space-y-6">
              <div><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block px-1">会議体名</label><div className="px-5 py-4 bg-gray-50 border border-gray-100 rounded-2xl font-bold text-gray-700 text-xs truncate leading-relaxed">{editTarget.meetingName}</div></div>
              <div><label className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2 block px-1 leading-none font-sans font-black">開催日 (和暦可 ➡ 西暦へ自動変換)</label><input type="text" autoFocus value={editTarget.latestDateString} onChange={e => setEditTarget({...editTarget, latestDateString: e.target.value})} className="w-full px-6 py-5 bg-indigo-50 border-2 border-indigo-100 rounded-2xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none font-black text-indigo-700 text-lg shadow-inner placeholder:opacity-30" placeholder="例: 令和8年4月14日" /></div>
              <div className="pt-4 flex gap-3"><button type="button" onClick={() => setEditTarget(null)} className="flex-1 py-4 bg-gray-100 text-gray-500 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs uppercase">キャンセル</button><button type="submit" disabled={isSaving} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 transition-all flex items-center justify-center gap-2 active:scale-95 text-xs uppercase">{isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />} 保存する</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
