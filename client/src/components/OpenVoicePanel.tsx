import React from 'react'

const REFERENCE_TARGET_MS = 15000
const MINIMUM_REFERENCE_MS = 5000

interface OpenVoicePanelProps {
  referenceStatus: 'recording' | 'ready' | 'idle'
  referenceStatusLabel: string
  referenceDurationLabel: string
  referenceDurationMs: number
  referenceRecording: boolean
  referenceAudioUrl: string | null
  referenceAudioBlob: Blob | null
  referenceFilename: string
  referenceRecorderError: string | null
  onStartRecording: () => void | Promise<void>
  onStopRecording: () => void
  onFilenameChange: (value: string) => void
  onDownload: () => void
  onClear: () => void
}

const OpenVoicePanel: React.FC<OpenVoicePanelProps> = ({
  referenceStatus,
  referenceStatusLabel,
  referenceDurationLabel,
  referenceDurationMs,
  referenceRecording,
  referenceAudioUrl,
  referenceAudioBlob,
  referenceFilename,
  referenceRecorderError,
  onStartRecording,
  onStopRecording,
  onFilenameChange,
  onDownload,
  onClear
}) => {
  const progressPercent = Math.min(referenceDurationMs / REFERENCE_TARGET_MS, 1) * 100
  const meetsMinimum = referenceDurationMs >= MINIMUM_REFERENCE_MS
  const progressHint = referenceRecording
    ? 'Recording in progress… aim for a clean 5–15 second clip.'
    : meetsMinimum
      ? 'Solid clip captured. Download or re-record if you heard noise.'
      : 'Need at least 5 seconds of audio before downloading.'

  const clipStateLabel = referenceRecording ? 'Recording' : referenceAudioBlob ? 'Clip ready' : 'Awaiting clip'
  const clipStateDescription = referenceRecording
    ? 'Mic is hot—keep a steady distance and speak naturally.'
    : referenceAudioBlob
      ? 'Preview the take below before sharing it with OpenVoice.'
      : 'Press record when you are ready to capture the talent.'

  const calloutTone = referenceRecording ? 'live' : meetsMinimum ? 'ready' : 'warning'
  const calloutTitle = referenceRecording
    ? 'Capturing reference clip'
    : meetsMinimum
      ? 'Clip ready for download'
      : 'Clip too short'
  const calloutDetail = referenceRecording
    ? 'Leave at least 5 seconds of clean audio before stopping the take.'
    : meetsMinimum
      ? 'Everything looks good. Download the clip and attach it to your next request.'
      : 'Record a little longer so OpenVoice has enough material to analyze.'

  const readinessMetrics = [
    {
      title: 'Clip status',
      value: clipStateLabel,
      hint: clipStateDescription
    },
    {
      title: 'Captured length',
      value: referenceDurationLabel,
      hint: 'Target 5–15 seconds for best fidelity.'
    },
    {
      title: 'Quality gate',
      value: meetsMinimum ? 'Pass' : 'Needs ≥5s',
      hint: meetsMinimum ? 'Meets minimum length requirement.' : 'Record a longer sample before exporting.'
    }
  ]

  const workflowSteps = [
    {
      title: 'Prep & monitor levels',
      detail: 'Mute fans, silence notifications, and eyeball your interface LEDs.'
    },
    {
      title: 'Capture & rename clip',
      detail: 'Speak 1–2 sentences, then label the file for quick recall.'
    },
    {
      title: 'Preview & deliver',
      detail: 'Listen back, download locally, and include it with your OpenVoice call.'
    }
  ]

  const handleRecordToggle = () => {
    if (referenceRecording) {
      onStopRecording()
      return
    }
    void onStartRecording()
  }

  return (
    <div className="openvoice-layout" aria-label="OpenVoice reference panel">
      <section className="panel-surface openvoice-panel">
        <header className="openvoice-header">
          <div className="openvoice-title-block">
            <p className="eyebrow">Voice capture</p>
            <h2>OpenVoice reference studio</h2>
            <p>Capture a short clip (5–15s) of your target voice for cloning & custom voices.</p>
          </div>
          <div className={`reference-status-pill reference-status-pill-${referenceStatus}`} aria-live="polite">
            <span className="status-dot" aria-hidden />
            {referenceStatusLabel}
          </div>
        </header>

        <div className="openvoice-metrics" role="list">
          {readinessMetrics.map((metric) => (
            <article key={metric.title} className="openvoice-metric-card" role="listitem">
              <p className="openvoice-metric-title">{metric.title}</p>
              <p className="openvoice-metric-value">{metric.value}</p>
              <p className="openvoice-metric-hint">{metric.hint}</p>
            </article>
          ))}
        </div>

        <div className={`openvoice-callout openvoice-callout-${calloutTone}`} role="status">
          <div className="callout-indicator" aria-hidden />
          <div>
            <p className="openvoice-callout-title">{calloutTitle}</p>
            <p className="openvoice-callout-detail">{calloutDetail}</p>
          </div>
        </div>

        <div className="openvoice-grid">
          <article className="openvoice-card capture-card" aria-label="OpenVoice capture controls">
            <div className="openvoice-card-header">
              <div>
                <h3>Capture controls</h3>
                <p>Use a quiet room and speak naturally.</p>
              </div>
              <span className="openvoice-duration">{referenceDurationLabel}</span>
            </div>
            <div
              className="reference-progress"
              role="img"
              aria-label={`Recorded ${referenceDurationLabel} of 0:15 target`}
            >
              <div className="reference-progress-bar" style={{ width: `${progressPercent}%` }} />
            </div>
            <p className="reference-progress-hint">{progressHint}</p>
            <div className="openvoice-action-row">
              <button
                type="button"
                className={`record-button ${referenceRecording ? 'recording' : ''}`}
                onClick={handleRecordToggle}
              >
                {referenceRecording ? '■ Stop recording' : '⏺ Start recording'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={onClear}
                disabled={referenceRecording || !referenceAudioBlob}
              >
                ♻ Re-record
              </button>
            </div>
          </article>

          <article className="openvoice-card clip-card" aria-label="OpenVoice clip details">
            <div className="openvoice-card-header">
              <div>
                <h3>Clip details</h3>
                <p>Generate a friendly file name and preview your take.</p>
              </div>
              <span className={`clip-status ${referenceAudioBlob ? 'ready' : 'pending'}`}>
                {referenceAudioBlob ? 'Ready' : 'Awaiting clip'}
              </span>
            </div>
            <label className="openvoice-field">
              <span>Filename prefix</span>
              <input
                type="text"
                className="reference-name-input"
                value={referenceFilename}
                onChange={(e) => onFilenameChange(e.target.value)}
                placeholder="openvoice-reference"
              />
            </label>
            <div className="openvoice-audio-preview">
              {referenceAudioUrl ? (
                <audio controls src={referenceAudioUrl} className="reference-audio-player" />
              ) : (
                <p className="reference-empty-hint">No clip yet. Tap “Start recording” to capture a reference.</p>
              )}
            </div>
            <div className="openvoice-action-row">
              <button type="button" onClick={onDownload} disabled={!referenceAudioBlob}>
                ⬇ Download clip
              </button>
              <button type="button" onClick={onClear} disabled={referenceRecording || !referenceAudioBlob}>
                Clear clip
              </button>
            </div>
          </article>
        </div>

        <div className="openvoice-guidelines-row">
          <article className="openvoice-card openvoice-guidelines" aria-label="Recording guidelines">
            <div className="openvoice-card-header">
              <div>
                <h3>Guidelines</h3>
                <p>Follow these tips for a clean sample.</p>
              </div>
            </div>
            <ul>
              <li>Record 1–2 sentences in a calm, conversational tone.</li>
              <li>Keep the mic 15–20 cm away to avoid plosives.</li>
              <li>Pause the HVAC / fans and wait for silence between takes.</li>
              <li>Name files after the talent or campaign for quick recall.</li>
            </ul>
          </article>
          <article className="openvoice-card openvoice-checklist" aria-label="Quality checklist">
            <div className="openvoice-card-header">
              <div>
                <h3>Quality checklist</h3>
                <p>Double-check before uploading to OpenVoice.</p>
              </div>
            </div>
            <ul>
              <li>Length between 5s and 15s.</li>
              <li>No clipping or background chatter.</li>
              <li>Speaker identity matches the desired clone.</li>
              <li>Download the clip to attach it to conversations.</li>
            </ul>
          </article>
          <article className="openvoice-card openvoice-workflow" aria-label="Capture workflow">
            <div className="openvoice-card-header">
              <div>
                <h3>Capture workflow</h3>
                <p>Run this playbook each time for consistent results.</p>
              </div>
            </div>
            <ol>
              {workflowSteps.map((step, index) => (
                <li key={step.title}>
                  <span className="workflow-step-index">{index + 1}</span>
                  <div>
                    <p className="workflow-step-title">{step.title}</p>
                    <p className="workflow-step-detail">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </article>
        </div>

        {referenceRecorderError && (
          <div className="reference-error" role="alert">
            {referenceRecorderError}
          </div>
        )}
      </section>
    </div>
  )
}

export default OpenVoicePanel
