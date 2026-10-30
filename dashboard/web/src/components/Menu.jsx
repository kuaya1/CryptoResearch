// Menus on Radix's accessible dropdown (arrow keys, Home/End, typeahead,
// Escape back to the button). Non-modal, so nothing writes styles into the
// page (the desk's Content-Security-Policy allows none) and the page keeps
// scrolling.
import * as DM from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';

// open/onOpenChange make it controlled (a command can open it by state).
export function Menu({ trigger, children, align = 'start', label, side = 'bottom', className = '', open, onOpenChange }) {
  const ctl = open === undefined ? {} : { open, onOpenChange };
  return (
    <DM.Root modal={false} {...ctl}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className={`menu ${className}`.trim()} align={align} side={side} sideOffset={6} collisionPadding={12} aria-label={label} loop>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function MenuItem({ children, desc = null, onSelect, href = null, danger = false, keep = false, ...rest }) {
  const body = (
    <span className="mi-main">
      <span>{children}</span>
      {desc ? <span className="mi-desc">{desc}</span> : null}
    </span>
  );
  const select = (e) => {
    if (keep) e.preventDefault();
    if (onSelect) onSelect(e);
  };
  if (href) {
    return (
      <DM.Item asChild onSelect={select} {...rest}>
        <a className={`menu-item${danger ? ' is-danger' : ''}`} href={href}>{body}</a>
      </DM.Item>
    );
  }
  return <DM.Item className={`menu-item${danger ? ' is-danger' : ''}`} onSelect={select} {...rest}>{body}</DM.Item>;
}

export function MenuLabel({ children }) {
  return <DM.Label className="menu-label">{children}</DM.Label>;
}

export function MenuSep() {
  return <DM.Separator className="menu-sep" />;
}

// A choice of one (a filter): stays open, so several can be set at once.
export function MenuRadio({ value, onChange, options, label }) {
  return (
    <DM.Group aria-label={label}>
      <DM.Label className="menu-label">{label}</DM.Label>
      <DM.RadioGroup value={value} onValueChange={onChange}>
        {options.map(([v, text, count]) => (
          <DM.RadioItem key={v} value={v} className="menu-item" onSelect={(e) => e.preventDefault()}>
            <span className="mi-check"><DM.ItemIndicator><Check size={14} strokeWidth={2.2} /></DM.ItemIndicator></span>
            <span className="mi-main">{text}</span>
            {count !== undefined ? <span className="mi-count">{count}</span> : null}
          </DM.RadioItem>
        ))}
      </DM.RadioGroup>
    </DM.Group>
  );
}

export function MenuCheck({ checked, onChange, children, disabled = false, desc = null }) {
  return (
    <DM.CheckboxItem className="menu-item" checked={checked} disabled={disabled} onCheckedChange={onChange} onSelect={(e) => e.preventDefault()}>
      <span className="mi-check"><DM.ItemIndicator><Check size={14} strokeWidth={2.2} /></DM.ItemIndicator></span>
      <span className="mi-main"><span>{children}</span>{desc ? <span className="mi-desc">{desc}</span> : null}</span>
    </DM.CheckboxItem>
  );
}

// A submenu: its own group of choices behind one item (arrow right opens it).
export function MenuSub({ label, children, open, onOpenChange, ...rest }) {
  const ctl = open === undefined ? {} : { open, onOpenChange };
  return (
    <DM.Sub {...ctl}>
      <DM.SubTrigger className="menu-item menu-sub" {...rest}>
        <span className="mi-main">{label}</span>
        <ChevronRight className="mi-go" size={14} aria-hidden="true" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent className="menu" sideOffset={4} collisionPadding={12} loop>
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}
