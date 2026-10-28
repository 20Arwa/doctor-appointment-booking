"use client"

import { usePathname } from "next/navigation"
import { Suspense, useEffect, useRef } from "react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <>
      <Suspense fallback={null}>
        <DismissToastsOnNavigation />
      </Suspense>
      <Sonner
        duration={4000}
        closeButton
        className="toaster group"
        icons={{
          success: <CircleCheckIcon className="size-4" />,
          info: <InfoIcon className="size-4" />,
          warning: <TriangleAlertIcon className="size-4" />,
          error: <OctagonXIcon className="size-4" />,
          loading: <Loader2Icon className="size-4 animate-spin" />,
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
          } as React.CSSProperties
        }
        toastOptions={{ classNames: { toast: "cn-toast" } }}
        {...props}
      />
    </>
  )
}

function DismissToastsOnNavigation() {
  const pathname = usePathname()
  const previousPathname = useRef(pathname)

  useEffect(() => {
    if (previousPathname.current !== pathname) toast.dismiss()
    previousPathname.current = pathname
  }, [pathname])

  return null
}

export { Toaster }
