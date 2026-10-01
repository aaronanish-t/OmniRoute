/**
 * Firbo AI logo mark (component name kept for upstream merge compatibility).
 */
type OmniRouteLogoProps = {
  size?: number;
  className?: string;
};

export default function OmniRouteLogo({ size = 20, className = "" }: OmniRouteLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      suppressHydrationWarning
    >
      {/* Firbo AI mark */}
      <path d="M9 6h14v4H13.5v4H21v4h-7.5v8H9V6z" fill="currentColor" />
    </svg>
  );
}
