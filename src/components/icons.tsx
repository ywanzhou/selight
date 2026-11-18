// SF Symbols-style line icons. Paths are lifted verbatim from the approved
// layout-macos-v3 mockup's SVG symbol defs; stroke-based icons inherit currentColor.
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function ImportIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </Svg>
  )
}

export function ExportIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 13V4m0 0L8.5 7.5M12 4l3.5 3.5" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
    </Svg>
  )
}

export function GridIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  )
}

export function ListIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" {...props}>
      <circle cx="5" cy="7" r="1.3" fill="currentColor" stroke="none" />
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} strokeLinecap="round" {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

// Folder is the one filled (non-stroke) glyph, matching the mockup's Finder-style mark.
export function FolderIcon(props: IconProps) {
  const { size = 16, ...rest } = props
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      {...rest}
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4a1.5 1.5 0 0 1 1.15.54l1.1 1.32a.5.5 0 0 0 .38.18H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11z" />
    </svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </Svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" />
    </Svg>
  )
}

export function XmarkIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

// Broom for cache cleanup: deliberately distinct from TrashIcon, since clearing
// the reversible media cache is not a destructive action.
export function BroomIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14.8 3.6 10.4 10.2" />
      <path d="M7.8 12.2 11.8 9.9l4.6 4.5-4 2.4z" />
      <path d="M10.4 15.2 8.9 19.6M12.4 16.7l-.3 3.9M14.5 15.6l1.4 4.1" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  )
}

// SF Symbol-style warning triangle for the missing-file corner badge.
export function WarningIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 4l9 15.5H3L12 4z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  )
}
