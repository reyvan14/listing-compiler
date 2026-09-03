/**
 * Listing-compiler entry icon: a package with a check mark.
 *
 * Hand-drawn to match ImageGenerateIcon / VideoGenerateIcon exactly — same
 * 18×18 box, 0.75 stroke, `currentColor`, round caps — so the three sidebar
 * entries share one visual weight. The project has no icon package and none is
 * being added.
 */
export function ListingCompilerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* carton outline */}
      <path
        d="M9 3.375L14.25 6.1875V11.8125L9 14.625L3.75 11.8125V6.1875L9 3.375Z"
        stroke="currentColor"
        strokeWidth="0.75"
        strokeLinejoin="round"
      />
      {/* top fold + centre seam */}
      <path
        d="M3.75 6.1875L9 9L14.25 6.1875"
        stroke="currentColor"
        strokeWidth="0.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 9V14.625" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" />
      {/* verified check */}
      <path
        d="M6.75 10.5L8.0625 11.8125L11.0625 8.8125"
        stroke="currentColor"
        strokeWidth="0.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
