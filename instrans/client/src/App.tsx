import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TranscriptEntry = {
  id: string;
  text: string;
  translation?: string;
  detectedLanguage?: string;
  targetLanguage?: string;
  timestamp: number;
};

type InstransSession = {
  id: string;
  targetLanguage: string;
  summary: string;
  transcripts: TranscriptEntry[];
  updatedAt: number;
};

type SessionResponse = {
  sessionId: string;
  session: InstransSession;
};

const API_BASE = (import.meta.env.VITE_INSTRANS_API_BASE || '').replace(/\/$/, '');
const API_SESSION_URL = `${API_BASE}/api/session`;
const API_CHUNK_URL = `${API_BASE}/api/chunk`;
const API_STREAM_URL = (sessionId: string) => `${API_BASE}/api/stream/${sessionId}`;

const TARGET_LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'th', label: 'Thai' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

const SOURCE_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'th', label: 'Thai' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

const formatTime = (timestamp?: number) => {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
};

const App: React.FC = () => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<InstransSession | null>(null);
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [statusMessage, setStatusMessage] = useState<string>('Initializing…');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [uploadingChunk, setUploadingChunk] = useState(false);
  const [manualUploadBusy, setManualUploadBusy] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const recentTranscripts = useMemo(() => {
    if (!session) return [];
    return [...session.transcripts].reverse().slice(0, 10);
  }, [session]);

  const connectSse = useCallback(
    (id: string) => {
      if (!id) return;
      eventSourceRef.current?.close();
      const source = new EventSource(API_STREAM_URL(id), { withCredentials: true });
      eventSourceRef.current = source;

      const handleSession = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as InstransSession;
          setSession(payload);
        } catch (err) {
          console.warn('Failed to parse session payload', err);
        }
      };

      const handleError = () => {
        setStatusMessage('Stream disconnected. Reconnecting…');
        source.close();
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => connectSse(id), 2000);
      };

      source.addEventListener('session', handleSession);
      source.onerror = handleError;
      source.onopen = () => {
        setStatusMessage('Connected. Awaiting audio…');
      };
    },
    [],
  );

  const createSession = useCallback(
    async (lang = targetLanguage) => {
      try {
        setStatusMessage('Creating session…');
        setErrorMessage(null);
        const response = await fetch(API_SESSION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetLanguage: lang }),
        });
        if (!response.ok) {
          throw new Error('Failed to create session');
        }
        const data = (await response.json()) as SessionResponse;
        setSessionId(data.sessionId);
        setSession(data.session);
        connectSse(data.sessionId);
        setStatusMessage('Session ready. Start listening when you are.');
      } catch (error) {
        console.error(error);
        setErrorMessage('Unable to create session. Please retry.');
        setStatusMessage('Idle');
      }
    },
    [connectSse, targetLanguage],
  );

  useEffect(() => {
    void createSession();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [createSession]);

  const patchTargetLanguage = useCallback(
    async (lang: string) => {
      if (!sessionId) return;
      try {
        await fetch(`${API_SESSION_URL}/${sessionId}/target-language`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetLanguage: lang }),
        });
      } catch (err) {
        console.warn('target language patch failed', err);
      }
    },
    [sessionId],
  );

  const uploadChunk = useCallback(
    async (blob: Blob) => {
      if (!sessionId) return;
      setUploadingChunk(true);
      try {
        const formData = new FormData();
        formData.append('audio', blob, `chunk-${Date.now()}.webm`);
        formData.append('sessionId', sessionId);
        formData.append('targetLanguage', targetLanguage);
        formData.append('sourceLanguage', sourceLanguage);

        const response = await fetch(API_CHUNK_URL, {
          method: 'POST',
          body: formData,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(detail || 'chunk_upload_failed');
        }
      } catch (err) {
        console.error('Chunk upload failed', err);
        setErrorMessage('Audio upload failed. See console for details.');
      } finally {
        setUploadingChunk(false);
      }
    },
    [sessionId, sourceLanguage, targetLanguage],
  );

  const stopListening = useCallback(() => {
    setListening(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setStatusMessage('Recording stopped.');
  }, []);

  const startListening = useCallback(async () => {
    if (!sessionId) {
      setErrorMessage('Session not ready yet.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('getUserMedia is not supported in this browser.');
      return;
    }
    try {
      setErrorMessage(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          void uploadChunk(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error('MediaRecorder error', event);
        setErrorMessage('Recorder error. Stopping.');
        stopListening();
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      };

      recorder.start(5000);
      setListening(true);
      setStatusMessage('Listening…');
    } catch (err) {
      console.error('Failed to access microphone', err);
      setErrorMessage('Unable to access microphone.');
    }
  }, [sessionId, stopListening, uploadChunk]);

  const handleToggleListening = useCallback(() => {
    if (listening) {
      stopListening();
    } else {
      void startListening();
    }
  }, [listening, startListening, stopListening]);

  const handleTargetChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const lang = event.target.value;
      setTargetLanguage(lang);
      void patchTargetLanguage(lang);
    },
    [patchTargetLanguage],
  );

  const handleManualUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.target.files?.length) return;
      const file = event.target.files[0];
      setManualUploadBusy(true);
      try {
        await uploadChunk(file);
      } finally {
        setManualUploadBusy(false);
        event.target.value = '';
      }
    },
    [uploadChunk],
  );

  const handleResetSession = useCallback(() => {
    if (listening) {
      stopListening();
    }
    setSessionId(null);
    setSession(null);
    void createSession(targetLanguage);
  }, [createSession, listening, stopListening, targetLanguage]);

  const latestTranscript = session?.transcripts.length ? session.transcripts[session.transcripts.length - 1] : undefined;
  const nowContent = latestTranscript?.text || 'Waiting for speech…';
  const translationContent = latestTranscript?.translation || 'Translation will appear here.';
  const summaryContent = session?.summary || 'Summary will build as conversation continues.';

  return (
    <div className="instrans-app">
      <header className="instrans-header">
        <div>
          <h1>Instrans</h1>
          <p>Continuous translation and summaries for multilingual conversations.</p>
        </div>
        <div className="status-cluster">
          <div className="status-text" aria-live="polite">
            <strong>Status:</strong> {statusMessage}
          </div>
          {errorMessage ? (
            <div className="status-error" role="alert">
              {errorMessage}
            </div>
          ) : null}
        </div>
      </header>

      <section className="controls-panel">
        <div className="control-group">
          <label htmlFor="target-language">Translate to</label>
          <select id="target-language" value={targetLanguage} onChange={handleTargetChange}>
            {TARGET_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="source-language">Source language</label>
          <select id="source-language" value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}>
            {SOURCE_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>Microphone</label>
          <button type="button" className={`primary-button ${listening ? 'danger' : ''}`} onClick={handleToggleListening}>
            {listening ? '■ Stop listening' : '🎙️ Start listening'}
          </button>
        </div>

        <div className="control-group">
          <label>Manual audio upload</label>
          <input type="file" accept="audio/*,video/*" disabled={manualUploadBusy || uploadingChunk} onChange={handleManualUpload} />
        </div>

        <div className="control-group">
          <label>Session</label>
          <button type="button" className="ghost-button" onClick={handleResetSession}>
            Reset session
          </button>
        </div>
      </section>

      <section className="panels-grid">
        <article className="info-panel">
          <header>
            <h2>Now</h2>
            <span className="panel-meta">Last heard @ {formatTime(latestTranscript?.timestamp)}</span>
          </header>
          <p className="panel-body">{nowContent}</p>
        </article>

        <article className="info-panel">
          <header>
            <h2>Instant translate</h2>
            <span className="panel-meta">Target: {targetLanguage.toUpperCase()}</span>
          </header>
          <p className="panel-body">{translationContent}</p>
        </article>

        <article className="info-panel">
          <header>
            <h2>Summary</h2>
            <span className="panel-meta">Auto-updated</span>
          </header>
          <p className="panel-body summary-text">{summaryContent}</p>
        </article>
      </section>

      <section className="history-panel">
        <header>
          <h3>Transcript history</h3>
          <span className="panel-meta">Showing latest {recentTranscripts.length} entries</span>
        </header>
        {recentTranscripts.length === 0 ? (
          <p className="muted">No transcripts yet. Start speaking to populate history.</p>
        ) : (
          <ul className="transcript-list">
            {recentTranscripts.map((entry) => (
              <li key={entry.id}>
                <div className="transcript-row">
                  <div>
                    <strong>{formatTime(entry.timestamp)}</strong>
                    <p>{entry.text}</p>
                  </div>
                  <div>
                    <span className="tag">{entry.detectedLanguage || 'auto'}</span>
                    <span className="tag">→ {entry.targetLanguage || targetLanguage}</span>
                  </div>
                </div>
                {entry.translation ? <p className="translation-text">{entry.translation}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="app-footer">
        <small>
          Session ID: <code>{sessionId || 'pending'}</code>
        </small>
        <small>
          Total entries: <strong>{session?.transcripts.length ?? 0}</strong>
        </small>
      </footer>
    </div>
  );
};

export default App;

