/**
 * 遥测/行为一致性断言（发行版恒 [] 实现，但断言列表由各调用点注入；
 * 开源侧按发行版语义：校验已登记的断言，返回失败项；全部通过返回 []）。
 */
export function runRequestVerificationParityAssertions(
  assertions?: Array<() => string | undefined>,
): string[] {
  if (!assertions?.length) {
    return [];
  }
  const failures: string[] = [];
  for (const assertion of assertions) {
    try {
      const failure = assertion();
      if (failure) {
        failures.push(failure);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
