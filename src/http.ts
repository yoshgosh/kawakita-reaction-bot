export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The provider error remains the useful failure if body cleanup also fails.
  }
}
