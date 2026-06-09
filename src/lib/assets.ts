// assets are mirrored from the spoolcast-content repo into public/content/ so
// they ship with the build (the old /@fs/… path only worked in the dev server)
export const asset = (path: string) => `/content/${path}`
