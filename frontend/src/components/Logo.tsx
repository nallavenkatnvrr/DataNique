import * as React from "react";

/**
 * Datanique mark: two overlapping rings (source and target) whose overlap —
 * the data that agrees — is lit. Inline SVG so it stays crisp at any size.
 */
export function Logo({ className, title = "Datanique" }: { className?: string; title?: string }) {
  const uid = React.useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <title>{title}</title>
      <defs>
        <linearGradient id={`bg-${uid}`} x1="4" y1="4" x2="60" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4338F2" />
          <stop offset="1" stopColor="#0891D1" />
        </linearGradient>
        <clipPath id={`l-${uid}`}>
          <circle cx="25" cy="32" r="13" />
        </clipPath>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="17" fill={`url(#bg-${uid})`} />
      <circle cx="39" cy="32" r="13" fill="#5EEAD4" clipPath={`url(#l-${uid})`} />
      <circle cx="25" cy="32" r="13" fill="none" stroke="#FFFFFF" strokeWidth="3.4" />
      <circle cx="39" cy="32" r="13" fill="none" stroke="#FFFFFF" strokeOpacity="0.72" strokeWidth="3.4" />
    </svg>
  );
}

export default Logo;
