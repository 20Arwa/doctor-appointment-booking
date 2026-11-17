"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "cn"

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({ className, sideOffset = 8, collisionPadding = 12, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content data-slot="popover-content" sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn("z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none", className)} {...props} />
  </PopoverPrimitive.Portal>
}

export { Popover, PopoverContent, PopoverTrigger }
