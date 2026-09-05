import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 20V0H4L12 12V0H16V20H12L4 8V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 100V0H20L60 60V0H80V100H60L20 40V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 254 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <path d="M0 36V6H6L18 24V6H24V36H18L6 18V36Z" fill="var(--icon-strong-base)" />
      <text
        x="38"
        y="31"
        fill="var(--icon-strong-base)"
        font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
        font-size="30"
        font-weight="600"
        letter-spacing="-1"
      >
        netsky code
      </text>
    </svg>
  )
}
