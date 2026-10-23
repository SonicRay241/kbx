import { useEffect, useState } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** Tailwind's `md` breakpoint — the same one where the sidebar stops being a rail. */
const SMALL_SCREEN = "(max-width: 767px)"

function useSmallScreen(): boolean {
  const [small, setSmall] = useState(
    () => typeof window !== "undefined" && window.matchMedia(SMALL_SCREEN).matches,
  )
  useEffect(() => {
    const query = window.matchMedia(SMALL_SCREEN)
    const onChange = () => setSmall(query.matches)
    onChange()
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return small
}

const Toaster = ({ ...props }: ToasterProps) => {
  const small = useSmallScreen()
  return (
    <Sonner
      theme="system"
      // Narrow screens get the card on top: a bottom toast would sit on the
      // thumb/action area once the sidebar turns into a sheet.
      position={small ? "top-center" : "bottom-right"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--color-background)",
          "--normal-text": "var(--color-foreground)",
          "--normal-border": "var(--color-border)",
          "--border-radius": "var(--radius-md)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }