type BinaryOperator = '+' | '-' | '*' | '/';

const MAX_EXPRESSION_LENGTH = 4_096;
const MAX_NESTING_DEPTH = 100;
const MAX_UNARY_OPERATOR_CHAIN = 100;

class ExpressionParser {
  private position = 0;

  constructor(private readonly input: string) {}

  parse(): number | undefined {
    this.skipWhitespace();

    if (this.position >= this.input.length) {
      return undefined;
    }

    const value = this.parseExpression();
    this.skipWhitespace();

    if (value === undefined || this.position !== this.input.length || !Number.isFinite(value)) {
      return undefined;
    }

    return Object.is(value, -0) ? 0 : value;
  }

  private parseExpression(): number | undefined {
    return this.parseBinaryExpression(() => this.parseTerm(), ['+', '-']);
  }

  private parseTerm(): number | undefined {
    return this.parseBinaryExpression(() => this.parseUnary(), ['*', '/']);
  }

  private parseBinaryExpression(
    parseOperand: () => number | undefined,
    operators: readonly BinaryOperator[],
  ): number | undefined {
    let value = parseOperand();

    if (value === undefined) {
      return undefined;
    }

    while (true) {
      this.skipWhitespace();
      const operator = this.peek();

      if (!isBinaryOperator(operator) || !operators.includes(operator)) {
        return value;
      }

      this.position += 1;
      const right = parseOperand();

      if (right === undefined) {
        return undefined;
      }

      value = applyBinaryOperator(value, operator, right);

      if (!Number.isFinite(value)) {
        return undefined;
      }
    }
  }

  private parseUnary(): number | undefined {
    this.skipWhitespace();
    const operator = this.peek();

    if (operator === '+' || operator === '-') {
      this.position += 1;
      const value = this.parseUnary();

      if (value === undefined) {
        return undefined;
      }

      return operator === '-' ? -value : value;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number | undefined {
    this.skipWhitespace();

    if (this.peek() === '(') {
      this.position += 1;
      const value = this.parseExpression();
      this.skipWhitespace();

      if (value === undefined || this.peek() !== ')') {
        return undefined;
      }

      this.position += 1;
      return value;
    }

    return this.parseNumber();
  }

  private parseNumber(): number | undefined {
    const start = this.position;
    let digitsBeforeDecimal = 0;
    let digitsAfterDecimal = 0;

    while (isDigit(this.peek())) {
      this.position += 1;
      digitsBeforeDecimal += 1;
    }

    if (this.peek() === '.') {
      this.position += 1;

      while (isDigit(this.peek())) {
        this.position += 1;
        digitsAfterDecimal += 1;
      }
    }

    if (digitsBeforeDecimal === 0 && digitsAfterDecimal === 0) {
      this.position = start;
      return undefined;
    }

    return Number(this.input.slice(start, this.position));
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) {
      this.position += 1;
    }
  }

  private peek(): string {
    return this.input[this.position] ?? '';
  }
}

function isExpressionWithinLimits(expression: string): boolean {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return false;
  }

  let depth = 0;
  let unaryOperatorChain = 0;
  let expectingOperand = true;

  for (const character of expression) {
    if (/\s/.test(character)) {
      continue;
    }

    if (character === '(') {
      depth += 1;
      unaryOperatorChain = 0;

      if (depth > MAX_NESTING_DEPTH) {
        return false;
      }

      expectingOperand = true;
      continue;
    }

    if (character === ')') {
      depth -= 1;
      unaryOperatorChain = 0;
      expectingOperand = false;
      continue;
    }

    if (expectingOperand && (character === '+' || character === '-')) {
      unaryOperatorChain += 1;

      if (unaryOperatorChain > MAX_UNARY_OPERATOR_CHAIN) {
        return false;
      }

      continue;
    }

    unaryOperatorChain = 0;
    expectingOperand = isBinaryOperator(character);
  }

  return true;
}

function isDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isBinaryOperator(value: string): value is BinaryOperator {
  return value === '+' || value === '-' || value === '*' || value === '/';
}

function applyBinaryOperator(left: number, operator: BinaryOperator, right: number): number {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? Number.NaN : left / right;
  }
}

function formatResult(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

export function evaluateExpression(expression: string): string | undefined {
  if (!isExpressionWithinLimits(expression)) {
    return undefined;
  }

  try {
    const value = new ExpressionParser(expression).parse();

    return value === undefined ? undefined : formatResult(value);
  } catch {
    return undefined;
  }
}
