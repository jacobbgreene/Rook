// Fully styled dropdown replacing native <select> — WebKitGTK renders
// native popups with platform colors, making dark-theme text unreadable.
import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  /** Muted suffix, e.g. "(no key)". */
  hint?: string;
}

export interface DropdownGroup {
  group: string;
  options: DropdownOption[];
}

interface DropdownProps {
  value: string;
  options: DropdownOption[] | DropdownGroup[];
  onChange: (value: string) => void;
  placeholder?: string;
}

function isGrouped(
  options: DropdownOption[] | DropdownGroup[],
): options is DropdownGroup[] {
  return options.length > 0 && "group" in options[0];
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = "Select...",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on click outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const flat: DropdownOption[] = isGrouped(options)
    ? options.flatMap((g) => g.options)
    : options;
  const selected = flat.find((o) => o.value === value);

  const renderOption = (o: DropdownOption) => (
    <button
      key={o.value}
      className={`dropdown-option ${o.value === value ? "dropdown-option-active" : ""}`}
      onClick={() => {
        onChange(o.value);
        setOpen(false);
      }}
    >
      {o.label}
      {o.hint && <span className="dropdown-option-hint"> {o.hint}</span>}
    </button>
  );

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        className="dropdown-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="dropdown-toggle-label">
          {selected ? selected.label : placeholder}
        </span>
        <span className={`dropdown-chevron ${open ? "dropdown-chevron-up" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div className="dropdown-list" role="listbox">
          {isGrouped(options)
            ? options.map((g) => (
                <div key={g.group}>
                  <div className="dropdown-group-label">{g.group}</div>
                  {g.options.map(renderOption)}
                </div>
              ))
            : options.map(renderOption)}
        </div>
      )}
    </div>
  );
}
