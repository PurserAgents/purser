/**
 * The Purser logo. This is the ONLY place the mark is drawn on the site (header and footer).
 * The image is public/logo.png (black mark, transparent background); dark mode shows it in white.
 * The favicon is app/icon.png and app/apple-icon.png; the share image reads public/logo.png.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={`logo-mark${className ? ` ${className}` : ""}`} src="/logo.png" width={size} height={size} alt="" aria-hidden="true" />
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return <LogoMark size={size} className="logo" />;
}
