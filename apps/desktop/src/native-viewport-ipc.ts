/** Shared names for the desktop native viewport lease bridge. */
/** Private desktop channels; the application renderer drives container windows through a lease. */
export const NATIVE_VIEWPORT_IPC = {
  acquire: 'dsh-native-viewport:acquire',
  setBounds: 'dsh-native-viewport:set-bounds',
  release: 'dsh-native-viewport:release',
} as const
