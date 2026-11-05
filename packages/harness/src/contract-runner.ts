export interface ContractImplementation<T> {
  name: string;
  create: () => Promise<T> | T;
  cleanup?: (instance: T) => Promise<void> | void;
}

export type ContractTestFn<T> = (getInstance: () => T) => void | Promise<void>;

export interface ContractSuite<T> {
  name: string;
  tests: {
    description: string;
    run: ContractTestFn<T>;
  }[];
}

/**
 * Executes a parameterized contract test suite across multiple implementations
 */
export async function executeContractSuite<T>(
  suite: ContractSuite<T>,
  impl: ContractImplementation<T>,
  onTestResult?: (testName: string, passed: boolean, error?: Error) => void
): Promise<{ passed: boolean; total: number; failures: number }> {
  let failures = 0;

  for (const test of suite.tests) {
    const instance = await impl.create();
    try {
      await test.run(() => instance);
      onTestResult?.(`${suite.name} -> ${impl.name}: ${test.description}`, true);
    } catch (err) {
      failures++;
      onTestResult?.(`${suite.name} -> ${impl.name}: ${test.description}`, false, err as Error);
    } finally {
      if (impl.cleanup) {
        await impl.cleanup(instance);
      }
    }
  }

  return {
    passed: failures === 0,
    total: suite.tests.length,
    failures,
  };
}
