declare module '@hermes/plugin-sdk' {
  export const host: import('./hermes-types').HermesHost
  export function useValue<T>(store: import('./hermes-types').Readable<T>): T
  export { useQuery, useQueryClient } from '@tanstack/react-query'
}
