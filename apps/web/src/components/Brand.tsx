export const PRODUCT_NAME = "Runbase";

export function BrandLogo({
  className = "brand-wordmark",
}: {
  className?: string;
}) {
  return (
    <span className={className} aria-label={PRODUCT_NAME}>
      <span aria-hidden="true">run</span>
      <span className="brand-divider" aria-hidden="true">
        /
      </span>
      <span aria-hidden="true">base</span>
    </span>
  );
}

export function BrandMark({
  size = 18,
  className = "logo-mark",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="currentColor" d="M38 6h12L26 58H14L38 6Z" />
    </svg>
  );
}
