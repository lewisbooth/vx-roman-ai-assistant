import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { readProductConfigurationDisplay } from "../tools/product-configuration";
import type { ProductGalleryImage } from "../tools/product-image";
import { ProductGallery } from "./ProductGallery";

type ProductDetails = {
  title: string;
  startingPrice?: string | null;
  configuration: ReturnType<typeof readProductConfigurationDisplay>;
  onAction: (action: "cart" | "sample") => Promise<void>;
  disabled: boolean;
};

function Details({
  title,
  configuration,
  startingPrice,
  compact = false,
  onAction,
  disabled,
}: ProductDetails & { compact?: boolean }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function request(action: "cart" | "sample") {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onAction(action);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Your request could not be sent. Please try again.",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  const measurements = configuration?.measurements;
  const hasMeasurements =
    !!measurements?.unit &&
    measurements.width !== null &&
    measurements.height !== null;
  const price =
    configuration?.configuredPrice || (compact ? startingPrice : null);
  const selected =
    configuration?.controls.flatMap((control) =>
      control.options
        .filter((option) => option.selected && option.available)
        .map((option) => ({
          key: control.id,
          label: control.label,
          value: option.label,
          separatePrice:
            control.purpose === "measurement_guarantee"
              ? option.priceLabel
              : undefined,
        })),
    ) ?? [];
  return (
    <div className="roman-product-stage-content">
      <h2>{title}</h2>
      {price && (
        <p className="roman-product-stage-price">
          <span>{price}</span>
        </p>
      )}
      {hasMeasurements ? (
        <p className="roman-product-stage-measurements">
          {measurements.width} × {measurements.height} {measurements.unit}
          {!compact && <span> Width × drop</span>}
        </p>
      ) : (
        compact && (
          <p className="roman-product-stage-measurements roman-product-stage-dimensions-prompt">
            Add dimensions for a quote
          </p>
        )
      )}
      {!compact && selected.length > 0 && (
        <div className="roman-product-stage-configuration">
          <dl>
            {selected.map((option) => (
              <div key={option.key}>
                <dt>{option.label}</dt>
                <dd>
                  {option.value}
                  {option.separatePrice && (
                    <span> ({option.separatePrice}, charged separately)</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!compact && (
        <div className="roman-product-actions">
          {configuration?.configuredPrice && (
            <button
              type="button"
              disabled={disabled || submitting}
              onClick={() => void request("cart")}
            >
              Add to Cart
            </button>
          )}
          <button
            type="button"
            className="roman-product-sample"
            disabled={disabled || submitting}
            onClick={() => void request("sample")}
          >
            Order Sample
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function ExpandIcon({ collapse = false }: { collapse?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={
          collapse
            ? "M20 4l-6 6m0-6v6h6M4 20l6-6m-6 0h6v6"
            : "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"
        }
      />
    </svg>
  );
}

function ExpandedProduct({
  title,
  configuration,
  gallery,
  pending,
  close,
  onAction,
  disabled,
}: ProductDetails & {
  gallery: readonly ProductGalleryImage[];
  pending: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    if (element.closest("[hidden]")) {
      close();
      return;
    }
    element.showModal();
    collapse.current?.focus({ preventScroll: true });
    // Native top-layer dialogs outlive a hidden ancestor unless explicitly
    // closed. Keep this view inside the bootstrap shell's open/close lifetime.
    const panel = element.closest("[data-roman-panel]");
    const observer = new MutationObserver(() => {
      if (panel?.hasAttribute("hidden")) close();
    });
    if (panel)
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    return () => {
      observer.disconnect();
      element.close();
    };
  }, [close]);
  return (
    <dialog
      ref={dialog}
      className="roman-product-expanded"
      aria-label={`${title} product details`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab")
          event.stopPropagation();
      }}
    >
      <header>
        <span>Your selection</span>
        <button
          ref={collapse}
          className="roman-product-expand"
          type="button"
          aria-label="Collapse selected product"
          onClick={close}
        >
          <ExpandIcon collapse />
        </button>
      </header>
      <ProductGallery
        items={gallery}
        title={title}
        pending={pending}
        allowZoom={false}
      />
      <Details
        title={title}
        configuration={configuration}
        disabled={disabled}
        onAction={async (action) => {
          await onAction(action);
          close();
        }}
      />
    </dialog>
  );
}

/** Responsive presentation reuses the stage's one live product/gallery snapshot. */
export function ProductStageView({
  title,
  startingPrice,
  configuration,
  gallery,
  pending,
  hidden,
  onAction,
  disabled,
}: ProductDetails & {
  gallery: readonly ProductGalleryImage[];
  pending: boolean;
  hidden: boolean;
}) {
  const [compact, setCompact] = useState(
    () => window.matchMedia?.("(max-width: 1023px)").matches ?? false,
  );
  const [expanded, setExpanded] = useState(false);
  const close = useCallback(() => setExpanded(false), []);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1023px)");
    if (!media) return;
    const update = () => {
      setCompact(media.matches);
      close();
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [close]);
  useEffect(() => {
    if (hidden) close();
  }, [hidden, close]);
  const thumbnail =
    gallery.find((image) => image.kind === "feature") ?? gallery[0];
  return (
    <aside
      className="roman-product-stage"
      aria-label="Your selected product"
      aria-busy={pending}
      hidden={hidden}
    >
      {compact ? (
        <div className="roman-product-stage-image roman-product-thumbnail">
          {thumbnail && (
            <img
              key={thumbnail.src}
              src={thumbnail.thumbnailSrc}
              alt=""
              width={52}
              height={52}
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          )}
          {pending && (
            <p className="roman-product-stage-loading" role="status">
              Opening your next page…
            </p>
          )}
        </div>
      ) : (
        <ProductGallery
          items={gallery}
          title={title}
          pending={pending}
          hidden={hidden}
        />
      )}
      <Details
        title={title}
        startingPrice={startingPrice}
        configuration={configuration}
        compact={compact}
        onAction={onAction}
        disabled={disabled}
      />
      {compact && (
        <button
          className="roman-product-expand"
          type="button"
          aria-label="Expand selected product"
          aria-haspopup="dialog"
          aria-expanded={expanded && !hidden}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            setExpanded(true);
          }}
        >
          <ExpandIcon />
        </button>
      )}
      {compact && expanded && !hidden && (
        <ExpandedProduct
          title={title}
          configuration={configuration}
          gallery={gallery}
          pending={pending}
          close={close}
          onAction={onAction}
          disabled={disabled}
        />
      )}
    </aside>
  );
}
