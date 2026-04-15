/**
 * 会議体ダッシュボード (機能修正版)
 * [修正内容]
 * 1. 自動更新スイッチ: config/system への書き込みを確実に実行。
 * 2. 全て既読ボタン: batch処理を修正し、全ての更新ありデータを一括で既読化。
 * 3. 分野プルダウン: デフォルトの並び順で登場する分野の順に表示を維持。
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, query, doc, updateDoc, serverTimestamp, writeBatch, getDoc, setDoc
} from 'firebase/firestore';
import { 
  Search, CheckCircle, Clock, AlertTriangle, ExternalLink, 
  RefreshCw, Edit3, X, Database, PlayCircle, Loader2, Tag, Filter, Save, UserCheck, WifiOff, CheckSquare, Square, StopCircle, Play, RotateCcw, Eye, ArrowUpDown, EyeOff, Bookmark, MapPin, Power, Hash
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

const MINISTRY_ORDER = [
  "内閣官房", "内閣府", "デジタル庁", "復興庁", "総務省", "法務省", "外務省", "財務省", 
  "文部科学省", "厚生労働省", "農林水産省", "経済産業省", "国土交通省", "環境省", "原子力規制委員会", "防衛省"
];

const parseDateToTs = (str) => {
  if (!str || typeof str !== 'string') return 0;
  try {
    const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/;
    const match = str.match(dateRegex);
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

const formatToWesternDate = (str) => {
  if (!str) return '';
  const ts = parseDateToTs(str);
  if (ts === 0) return str.replace(/\s*\(.*?\)\s*/g, ''); 
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [isAutoUpdateOn, setIsAutoUpdateOn] = useState(true);
  const [loading, setLoading] = useState(true);
  
  const [statusFilter, setStatusFilter] = useState('all');
  const [fieldFilter, setFieldFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState('default'); 
  
  const [editTarget, setEditTarget] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [checkingId, setCheckingId] = useState(null); 
  const [isBulkChecking, setIsBulkChecking] = useState(false);

  useEffect(() => {
    const startAuth = async () => {
      if (!auth.currentUser) await signInAnonymously(auth);
      const configSnap = await getDoc(getSystemConfigDoc());
      if (configSnap.exists()) {
        setIsAutoUpdateOn(configSnap.data().autoUpdateEnabled ?? true);
      }
    };
    startAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsubscribe = onSnapshot(query(getMeetingsCol()), (snapshot) => {
      const data = snapshot.docs.map(doc => {
        const d = doc.data();
        const rawDateStr = d['直近開催日'] || d.latestDateString || '';
        return {
          id: doc.id,
          meetingName: d['会議名'] || d.meetingName || '無題の会議',
          url: d['URL'] || d.url || '',
          agency: d['所管'] || d['省庁'] || d.agency || '-',
          relatedField: d['関連分野'] || d.relatedField || '-',
          latestDateString: rawDateStr, 
          latestDateTimestamp: d.latestDateTimestamp || parseDateToTs(rawDateStr),
          previousDateString: d.previousDateString || '',
          meetingRound: d.meetingRound || '',
          status: d.status || 'unchanged',
          isManual: d.isManual || false, 
          lastCheckedAt: d.lastCheckedAt,
          errorMessage: d.errorMessage || null,
          createdAt: d.createdAt || null
        };
      });
      setMeetings(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [user]);

  // 自動更新スイッチの処理を修正
  const toggleAutoUpdate = async () => {
    const newVal = !isAutoUpdateOn;
    setIsAutoUpdateOn(newVal); // UIを即座に変更
    try {
      await setDoc(getSystemConfigDoc(), { 
        autoUpdateEnabled: newVal, 
        lastModifiedAt: serverTimestamp() 
      }, { merge: true });
    } catch (e) {
      console.error("設定の保存に失敗しました", e);
      setIsAutoUpdateOn(!newVal); // 失敗時は戻す
    }
  };

  // 全て既読ボタンの処理を修正
  const handleMarkAllRead = async () => {
    const updatedMeetings = meetings.filter(m => m.status === 'updated');
    if (updatedMeetings.length === 0) return;
    if (!window.confirm(`${updatedMeetings.length} 件の通知をすべて既読にしますか？`)) return;

    const batch = writeBatch(db);
    updatedMeetings.forEach(m => {
      batch.update(getMeetingDoc(m.id), { 
        status: 'unchanged', 
        isManual: false,
        previousDateString: "" 
      });
    });
    
    try {
      await batch.commit();
    } catch (e) {
      console.error("一括既読処理に失敗しました", e);
    }
  };

  const defaultSortFunc = (a, b) => {
    const getPriority = (m) => {
      if (m.status === 'updated' && !m.isManual) return 1;
      if (m.status === 'updated' && m.isManual) return 2;
      if (m.status === 'error') return 3;
      return 4;
    };
    const priA = getPriority(a);
    const priB = getPriority(b);
    if (priA !== priB) return priA - priB;
    const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (Number(a.createdAt) || 0);
    const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (Number(b.createdAt) || 0);
    return timeA - timeB;
  };

  const uniqueFields = useMemo(() => {
    const sortedMeetings = [...meetings].sort(defaultSortFunc);
    const fields = [];
    sortedMeetings.forEach(m => {
      if (m.relatedField && m.relatedField !== '-' && !fields.includes(m.relatedField)) fields.push(m.relatedField);
    });
    return fields;
  }, [meetings]);

  const uniqueAgencies = useMemo(() => {
    const agencies = new Set();
    meetings.forEach(m => { if (m.agency && m.agency !== '-') agencies.add(m.agency); });
    return Array.from(agencies).sort((a, b) => {
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
      const matchesField = fieldFilter === 'all' || m.relatedField === fieldFilter;
      const matchesAgency = agencyFilter === 'all' || m.agency === agencyFilter;
      const matchesSearch = (m.meetingName || "").toLowerCase().includes(searchQuery.toLowerCase());
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
      return defaultSortFunc(a, b);
    });
  }, [meetings, statusFilter, fieldFilter, agencyFilter, searchQuery, sortMode]);

  const executeCheck = async (meeting) => {
    if (!meeting.url || !user) return;
    setCheckingId(meeting.id);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(meeting.url)}`, { signal: controller.signal });
      const data = await res.json();
      const html = data.contents;
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const plainText = (tempDiv.innerText || tempDiv.textContent).replace(/\s+/g, ' ');
      const nameIndex = plainText.indexOf(meeting.meetingName);
      if (nameIndex === -1) throw new Error("会議名不明");

      const searchText = plainText.substring(nameIndex, nameIndex + 800);
      const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/g;
      const roundRegex = /第\s*?(\d+|元)\s*?回/g;

      let foundDateTs = 0, foundDateStr = '', foundRound = '';
      const dMatch = dateRegex.exec(searchText);
      if (dMatch) { foundDateTs = parseDateToTs(dMatch[0]); foundDateStr = dMatch[0]; }
      const rMatch = roundRegex.exec(searchText);
      if (rMatch) foundRound = rMatch[0];

      const westernDate = formatToWesternDate(foundDateStr);
      const registeredTs = meeting.latestDateTimestamp || 0;
      const registeredRound = meeting.meetingRound || '';
      
      if (foundDateTs > registeredTs || (foundRound && foundRound !== registeredRound)) {
        const finalDate = westernDate || formatToWesternDate(meeting.latestDateString);
        const finalRound = foundRound || meeting.meetingRound;
        const combinedStr = finalRound ? `${finalDate} (${finalRound})` : finalDate;

        await updateDoc(getMeetingDoc(meeting.id), {
          latestDateString: combinedStr,
          '直近開催日': combinedStr,
          latestDateTimestamp: foundDateTs || meeting.latestDateTimestamp,
          meetingRound: finalRound,
          previousDateString: meeting.latestDateString,
          status: 'updated',
          isManual: false, 
          lastCheckedAt: serverTimestamp(),
          errorMessage: null
        });
      } else {
        await updateDoc(getMeetingDoc(meeting.id), { lastCheckedAt: serverTimestamp(), errorMessage: null });
      }
    } catch (e) {
      if (e.name !== 'AbortError') await updateDoc(getMeetingDoc(meeting.id), { status: 'error', errorMessage: "失敗", lastCheckedAt: serverTimestamp() });
    } finally { setCheckingId(null); clearTimeout(timeoutId); }
  };

  const handleToggleStatus = async (meeting) => {
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
      const pureDate = formatToWesternDate(editTarget.latestDateString);
      const newTs = parseDateToTs(pureDate);
      const combinedStr = editTarget.meetingRound ? `${pureDate} (${editTarget.meetingRound})` : pureDate;
      await updateDoc(getMeetingDoc(editTarget.id), {
        '直近開催日': combinedStr, latestDateString: combinedStr, latestDateTimestamp: newTs,
        meetingRound: editTarget.meetingRound || '', status: 'unchanged', isManual: false, lastModifiedAt: serverTimestamp()
      });
      setEditTarget(null);
    } catch (e) { alert("失敗"); } finally { setIsSaving(false); }
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

  if (loading && meetings.length === 0) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><Loader2 className="w-10 h-10 text-indigo-600 animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 font-sans text-gray-900">
      <div className="max-w-7xl mx-auto space-y-4">
        
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
            {/* 修正：自動更新スイッチ */}
            <div className="flex items-center gap-3 bg-gray-50 px-4 py-2.5 rounded-2xl border border-gray-100 shadow-inner">
              <div className={`p-2 rounded-xl ${isAutoUpdateOn ? 'bg-green-500 text-white' : 'bg-gray-300 text-white'} transition-colors`}><Power className="w-4 h-4" /></div>
              <div className="flex flex-col text-xs font-black leading-none">
                <span className="text-[9px] text-gray-400 uppercase tracking-tighter mb-1">Daily Auto Update</span>
                <div className="flex items-center gap-2">
                  <span className={isAutoUpdateOn ? 'text-green-600' : 'text-gray-400'}>{isAutoUpdateOn ? 'ENABLED' : 'DISABLED'}</span>
                  <button onClick={toggleAutoUpdate} className={`relative w-8 h-4 rounded-full transition-colors ${isAutoUpdateOn ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${isAutoUpdateOn ? 'translate-x-4' : ''}`}></div>
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
            <button onClick={() => setIsBulkChecking(true)} className="flex items-center gap-2 px-6 py-2.5 rounded-2xl font-black shadow-lg bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 text-sm"><RefreshCw className="w-5 h-5" /> 一括巡回</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <button onClick={() => { setStatusFilter('all'); setFieldFilter('all'); setAgencyFilter('all'); setSearchQuery(''); }} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'all' ? 'ring-4 ring-indigo-50 border-indigo-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">総監視数</span>
            <span className="text-2xl font-black text-gray-900">{summary.total}</span>
          </button>
          <button onClick={() => setStatusFilter('updated')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'updated' ? 'ring-4 ring-red-50 border-red-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-red-400">更新あり</span>
            <span className="text-2xl font-black text-red-600 animate-pulse">{summary.updated}</span>
          </button>
          <button onClick={() => setStatusFilter('manual')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'manual' ? 'ring-4 ring-blue-50 border-blue-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-blue-400">チェック用</span>
            <span className="text-2xl font-black text-blue-600">{summary.manual}</span>
          </button>
          <button onClick={() => setStatusFilter('unchanged')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'unchanged' ? 'ring-4 ring-gray-100 border-gray-400 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-gray-400">変更なし</span>
            <span className="text-2xl font-black text-gray-900">{summary.unchanged}</span>
          </button>
          <button onClick={() => setStatusFilter('error')} className={`p-4 rounded-[2rem] border bg-white text-left transition-all ${statusFilter === 'error' ? 'ring-4 ring-orange-50 border-orange-500 shadow-xl' : 'border-gray-100 shadow-sm'}`}>
            <span className="text-[9px] font-black block mb-1 uppercase tracking-widest text-orange-400">エラー</span>
            <span className="text-2xl font-black text-orange-600">{summary.error}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative group md:col-span-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="キーワード検索..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-10 pr-10 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm text-sm font-bold focus:ring-2 focus:ring-indigo-50 outline-none" />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-indigo-600 rounded-full"><X className="w-4 h-4" /></button>}
          </div>
          <div className="relative">
            <Filter className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={fieldFilter} onChange={e => setFieldFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm outline-none cursor-pointer">
              <option value="all">全ての分野</option>
              {uniqueFields.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="relative">
            <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select value={agencyFilter} onChange={e => setAgencyFilter(e.target.value)} className="w-full pl-10 pr-8 py-3 bg-white border border-gray-100 rounded-2xl appearance-none font-black text-gray-700 text-xs shadow-sm outline-none cursor-pointer">
              <option value="all">全ての所管</option>
              {uniqueAgencies.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        <div className="bg-white rounded-[2.5rem] shadow-xl border border-gray-100 overflow-hidden min-h-[450px]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="bg-gray-50/50 text-gray-400 font-black border-b border-gray-100 uppercase tracking-widest text-[9px]">
                <tr>
                  <th className="px-6 py-6 w-60">状態 / 巡回時間</th>
                  <th className="px-6 py-6">会議体名 / 分野 / 所管</th>
                  <th className="px-6 py-6 text-center w-64">開催状況 (日付・回数)</th>
                  <th className="px-8 py-6 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredAndSortedMeetings.map(m => (
                  <tr key={m.id} className={`group hover:bg-gray-50/10 transition-all ${m.status === 'updated' && !m.isManual ? 'bg-red-50/10' : ''}`}>
                    <td className="px-6 py-4 align-middle">
                      <div className="flex flex-col gap-1.5 items-start">
                        {m.status === 'updated' ? (
                          <>
                            <div className="flex items-center gap-2">
                              <button onClick={() => handleToggleStatus(m)} className="px-3 py-1 bg-red-600 text-white text-[9px] font-black rounded-lg hover:bg-red-700 shadow-sm flex items-center gap-1 active:scale-95 transition-all">
                                <CheckCircle className="w-3 h-3" /> 既読にする
                              </button>
                              <span className="text-[7.5px] text-gray-400 font-bold opacity-80 uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <div className={`flex items-center gap-1.5 text-[8.5px] font-black px-2 py-0.5 rounded border ${m.isManual ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-red-50 text-red-600 border-red-200'}`}>
                               {m.isManual ? <Bookmark className="w-2.5 h-2.5 text-blue-500" /> : <RefreshCw className="w-2.5 h-2.5 animate-spin-slow text-red-500" />}
                               {m.isManual ? 'チェック用' : '未読（新着）'}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <div className={`flex items-center gap-1 text-[8.5px] font-black px-2 py-1 rounded-lg border leading-none ${m.status === 'error' ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                                 {m.status === 'error' ? <AlertTriangle className="w-2.5 h-2.5" /> : <CheckCircle className="w-2.5 h-2.5 text-gray-300" />}
                                 {m.status === 'error' ? 'エラー' : '変更なし'}
                              </div>
                              <span className="text-[7.5px] text-gray-400 font-bold uppercase">{formatCheckTime(m.lastCheckedAt)}</span>
                            </div>
                            <button onClick={() => handleToggleStatus(m)} className="text-[8px] font-black text-indigo-400 hover:text-indigo-600 px-2 leading-none">未読とする</button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 align-middle">
                      <div className="font-semibold text-gray-900 text-sm leading-tight line-clamp-1 group-hover:text-indigo-600 transition-colors">{m.meetingName}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-1 opacity-70">
                        <span className="flex items-center gap-1 text-[8px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 shadow-sm"><Tag className="w-2.5 h-2.5" /> {m.relatedField || '-'}</span>
                        <span className="flex items-center gap-1 text-[8px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 shadow-sm"><MapPin className="w-2.5 h-2.5" /> {m.agency}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 align-middle text-center">
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        <div className={`text-xs font-black ${m.status === 'updated' && !m.isManual ? 'text-red-600 animate-pulse' : 'text-gray-600'}`}>{m.latestDateString || '未定'}</div>
                        {m.previousDateString && <div className="text-[10px] text-gray-400 font-bold opacity-70 line-through leading-none">{m.previousDateString}</div>}
                      </div>
                    </td>
                    <td className="px-8 py-4 align-middle text-right">
                      <div className="flex justify-end items-center gap-1.5 opacity-30 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => executeCheck(m)} disabled={checkingId === m.id} className="p-2 text-indigo-600 bg-white border border-indigo-50 rounded-xl hover:bg-indigo-600 hover:text-white transition-all shadow-sm active:scale-90">
                          {checkingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                        </button>
                        <button onClick={() => setEditTarget(m)} className="p-2 text-blue-600 bg-white border border-blue-50 rounded-xl hover:bg-blue-600 hover:text-white transition-all shadow-sm active:scale-90"><Edit3 className="w-4 h-4" /></button>
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="p-2 text-gray-400 bg-white border border-gray-100 rounded-xl hover:text-indigo-600 transition-all shadow-sm"><ExternalLink className="w-4 h-4" /></a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editTarget && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 border border-gray-100 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6"><h2 className="font-black text-gray-900 flex items-center gap-2 text-base leading-none"><Edit3 className="w-5 h-5 text-blue-600" /> データの修正</h2><button onClick={() => setEditTarget(null)} className="p-2 text-gray-400 hover:bg-gray-200 rounded-full transition-all"><X className="w-5 h-5" /></button></div>
            <form onSubmit={handleSaveEdit} className="space-y-6">
              <div><label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block px-1">会議体名</label><div className="px-5 py-4 bg-gray-50 border border-gray-100 rounded-2xl font-bold text-gray-700 text-xs truncate leading-relaxed">{editTarget.meetingName}</div></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2 block px-1 leading-none font-black mb-2">開催日</label><input type="text" value={editTarget.latestDateString.replace(/\s*\(.*?\)\s*/g, '')} onChange={e => setEditTarget({...editTarget, latestDateString: e.target.value})} className="w-full px-5 py-4 bg-indigo-50 border-2 border-indigo-100 rounded-2xl focus:ring-4 focus:ring-indigo-100 outline-none font-black text-indigo-700 text-sm shadow-inner" placeholder="令和〇年〇月〇日" /></div>
                <div><label className="text-[10px] font-black text-orange-600 uppercase tracking-widest mb-2 block px-1 leading-none font-black mb-2">開催回数</label><input type="text" value={editTarget.meetingRound} onChange={e => setEditTarget({...editTarget, meetingRound: e.target.value})} className="w-full px-5 py-4 bg-orange-50 border-2 border-orange-100 rounded-2xl focus:ring-4 focus:ring-orange-100 outline-none font-black text-orange-700 text-sm shadow-inner" placeholder="第〇回" /></div>
              </div>
              <div className="pt-4 flex gap-3"><button type="button" onClick={() => setEditTarget(null)} className="flex-1 py-4 bg-gray-100 text-gray-500 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs">キャンセル</button><button type="submit" disabled={isSaving} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl transition-all active:scale-95 text-xs">{isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />} 保存する</button></div>
            </form>
          </div>
        </div>
      )}

      {isBulkChecking && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-md flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-8 text-center space-y-5 animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto shadow-inner"><RefreshCw className="w-8 h-8 animate-spin" /></div>
            <h3 className="text-xl font-black text-gray-900 tracking-tight leading-tight px-2">一括巡回を開始します</h3>
            <p className="text-xs text-gray-500 font-bold px-4 leading-relaxed">全件のサイトを確認し、最新の日付と回数を上書き保存します。</p>
            <div className="pt-4 flex gap-3"><button onClick={() => setIsBulkChecking(false)} className="flex-1 py-4 bg-gray-100 text-gray-400 font-black rounded-2xl hover:bg-gray-200 transition-all text-xs">戻る</button><button onClick={async () => { setIsBulkChecking(false); for(let m of filteredAndSortedMeetings) { await executeCheck(m); } }} className="flex-1 py-4 bg-indigo-600 text-white font-black rounded-2xl hover:bg-indigo-700 shadow-xl transition-all active:scale-95 text-xs">開始する</button></div>
          </div>
        </div>
      )}
    </div>
  );
}