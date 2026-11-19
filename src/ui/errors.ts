export interface FetchFailure {
  code?: string;
  message?: string;
  status?: number | null;
}

export class ConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

export function failureFrom(error: unknown): { code: string; message: string } {
  if (error instanceof ConversionError)
    return { code: error.code, message: error.message };
  if (typeof error === "object" && error !== null) {
    const failure = error as FetchFailure;
    return {
      code: failure.code || "unknown_error",
      message: failure.message || "请求失败，请检查订阅地址和网络连接。",
    };
  }
  if (typeof error === "string" && error.trim()) {
    return { code: "unknown_error", message: error };
  }
  return { code: "unknown_error", message: "请求失败，请稍后重试。" };
}
