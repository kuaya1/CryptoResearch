// The desk's mark: three models around one project.
export function Mark({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4" />
      <circle cx="16" cy="16" r="3.8" fill="currentColor" />
      <circle cx="16" cy="5.5" r="3.1" fill="currentColor" />
      <circle cx="6.9" cy="21.3" r="3.1" fill="currentColor" />
      <circle cx="25.1" cy="21.3" r="3.1" fill="currentColor" />
    </svg>
  );
}
