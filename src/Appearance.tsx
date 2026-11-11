import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronUp,
  Moon,
  Palette as PaletteIcon,
  Sun,
} from "lucide-react";
import {
  APPEARANCE_STORAGE_KEY,
  PALETTES,
  applyAppearance,
  readAppearance,
  saveAppearance,
  validateAppearance,
  type AppearancePreferences,
  type ColorMode,
} from "./theme";
import "./theme.css";

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearancePreferences>(() =>
    readAppearance(),
  );
  const [persisted, setPersisted] = useState(true);
  useLayoutEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  useEffect(() => {
    setPersisted(saveAppearance(appearance));
  }, [appearance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
      try {
        setAppearance(
          validateAppearance(
            event.newValue ? JSON.parse(event.newValue) : null,
          ),
        );
      } catch {
        setAppearance(validateAppearance(null));
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return { appearance, setAppearance, persisted };
}

/** Nonmodal popover, portalled so the sidebar's overflow cannot clip it. */
export default function Appearance({
  onOpenChange,
}: { onOpenChange?: (open: boolean) => void } = {}) {
  const { appearance, setAppearance, persisted } = useAppearance();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, bottom: 60 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const modeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const paletteButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const panelId = useId();
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const modes: { value: ColorMode; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Day", Icon: Sun },
    { value: "dark", label: "Night", Icon: Moon },
  ];
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        left: Math.max(10, Math.min(rect.left, window.innerWidth - 286)),
        bottom: Math.max(
          10,
          Math.min(window.innerHeight - rect.top + 9, window.innerHeight - 300),
        ),
      });
    };
    place();
    modeButtons.current[appearance.mode === "light" ? 0 : 1]?.focus({
      preventScroll: true,
    });
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // Only focus when opening, not while the user changes a swatch.
  }, [open]);
  const radioKeys = (
    event: ReactKeyboardEvent,
    current: number,
    count: number,
    choose: (index: number) => void,
  ) => {
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (current + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (current - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    choose(next);
  };
  return (
    <div className="appearance-control">
      <button
        ref={trigger}
        className="appearance-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <PaletteIcon size={15} />
        <span>Appearance</span>
        <ChevronUp
          size={12}
          className={open ? "appearance-chevron open" : "appearance-chevron"}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            className="appearance-panel"
            role="dialog"
            aria-label="Appearance"
            style={{ left: position.left, bottom: position.bottom }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (
                next instanceof Node &&
                !event.currentTarget.contains(next) &&
                !trigger.current?.contains(next)
              )
                setOpen(false);
            }}
          >
            <h2>Appearance</h2>
            <div
              className="appearance-modes"
              role="radiogroup"
              aria-label="Color mode"
            >
              {modes.map(({ value, label, Icon }, index) => (
                <button
                  key={value}
                  ref={(node) => {
                    modeButtons.current[index] = node;
                  }}
                  role="radio"
                  aria-checked={appearance.mode === value}
                  tabIndex={appearance.mode === value ? 0 : -1}
                  className={appearance.mode === value ? "active" : ""}
                  onClick={() =>
                    setAppearance((previous) => ({ ...previous, mode: value }))
                  }
                  onKeyDown={(event) =>
                    radioKeys(event, index, modes.length, (next) => {
                      setAppearance((previous) => ({
                        ...previous,
                        mode: modes[next].value,
                      }));
                      modeButtons.current[next]?.focus({ preventScroll: true });
                    })
                  }
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <div className="appearance-palette-label" id={panelId + "-palette"}>
              Palette
            </div>
            <div
              className="appearance-palettes"
              role="radiogroup"
              aria-labelledby={panelId + "-palette"}
            >
              {PALETTES.map((palette, index) => (
                <button
                  key={palette.id}
                  ref={(node) => {
                    paletteButtons.current[index] = node;
                  }}
                  role="radio"
                  aria-checked={appearance.palette === palette.id}
                  tabIndex={appearance.palette === palette.id ? 0 : -1}
                  className={appearance.palette === palette.id ? "active" : ""}
                  onClick={() =>
                    setAppearance((previous) => ({
                      ...previous,
                      palette: palette.id,
                    }))
                  }
                  onKeyDown={(event) =>
                    radioKeys(event, index, PALETTES.length, (next) => {
                      setAppearance((previous) => ({
                        ...previous,
                        palette: PALETTES[next].id,
                      }));
                      paletteButtons.current[next]?.focus({
                        preventScroll: true,
                      });
                    })
                  }
                >
                  <span
                    className="appearance-swatch"
                    style={{ background: palette.color }}
                  >
                    {appearance.palette === palette.id && <Check size={13} />}
                  </span>
                  <span>{palette.label}</span>
                </button>
              ))}
            </div>
            {!persisted && (
              <p className="appearance-storage-note" role="status">
                Changes apply in this tab. Browser storage is unavailable.
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
