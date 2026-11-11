import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, Moon, Sun } from "lucide-react";
import {
  APPEARANCE_STORAGE_KEY,
  PALETTES,
  applyAppearance,
  readAppearance,
  saveAppearance,
  validateAppearance,
  type AppearancePreferences,
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

/** Always-visible swatches and one-click mode switching. */
export default function Appearance() {
  const { appearance, setAppearance, persisted } = useAppearance();
  const paletteButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const modeAction =
    appearance.mode === "dark" ? "Switch to day mode" : "Switch to night mode";
  const radioKeys = (event: ReactKeyboardEvent, current: number) => {
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (current + 1) % PALETTES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (current - 1 + PALETTES.length) % PALETTES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PALETTES.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setAppearance((previous) => ({ ...previous, palette: PALETTES[next].id }));
    paletteButtons.current[next]?.focus({ preventScroll: true });
  };
  return (
    <div className="appearance-control">
      <div className="appearance-inline">
        <div
          className="appearance-swatches"
          role="radiogroup"
          aria-label="Color palette"
        >
          {PALETTES.map((palette, index) => (
            <button
              key={palette.id}
              ref={(node) => {
                paletteButtons.current[index] = node;
              }}
              className={`appearance-swatch-button ${appearance.palette === palette.id ? "active" : ""}`}
              role="radio"
              aria-label={`${palette.label} palette`}
              title={palette.label}
              aria-checked={appearance.palette === palette.id}
              tabIndex={appearance.palette === palette.id ? 0 : -1}
              onClick={() =>
                setAppearance((previous) => ({
                  ...previous,
                  palette: palette.id,
                }))
              }
              onKeyDown={(event) => radioKeys(event, index)}
            >
              <span
                className="appearance-swatch"
                style={{ background: palette.color }}
                aria-hidden="true"
              >
                {appearance.palette === palette.id && (
                  <Check size={10} strokeWidth={2.5} />
                )}
              </span>
            </button>
          ))}
        </div>
        <button
          className="appearance-mode-button"
          title={modeAction}
          aria-label={modeAction}
          onClick={() =>
            setAppearance((previous) => ({
              ...previous,
              mode: previous.mode === "dark" ? "light" : "dark",
            }))
          }
        >
          {appearance.mode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      {!persisted && (
        <span className="appearance-storage-note" role="status">
          Theme changes apply in this tab only.
        </span>
      )}
    </div>
  );
}
