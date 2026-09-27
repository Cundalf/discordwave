/**
 * Error con mensaje listo para mostrar al usuario de Discord.
 * Cualquier otro error NUNCA se muestra en el chat: va crudo al log
 * (docker logs) y al usuario le toca mensaje genérico.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** el error es mostrable (con mensaje de estado, no stack crudo) */
export function userFacingMessage(err: unknown): string | null {
  if (err instanceof UserFacingError) return err.message;
  const s = err instanceof Error ? err.message : String(err);
  if (/no pude abrir el stream/i.test(s)) {
    return "**La radio no está al aire en este momento**. Probá más tarde.";
  }
  if (/password/i.test(s)) {
    return "El password de la radio ya no funciona — avisale al operador.";
  }
  return null;
}
