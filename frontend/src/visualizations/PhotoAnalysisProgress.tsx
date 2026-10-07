export function PhotoAnalysisProgress({ progress }: { progress: number }) {
  return <span className="roman-generation-content roman-analysis-content">
    <span className="roman-analysis-label">Analyzing your room</span>
    <span className="roman-generation-progress" role="progressbar" aria-label="Estimated room analysis progress"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-valuetext={`${Math.round(progress)}%. Estimated progress.`}>
      <span style={{ width: `${progress}%` }} />
    </span>
  </span>;
}
