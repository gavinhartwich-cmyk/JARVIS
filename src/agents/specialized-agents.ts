/**
 * Specialized Agent Definitions
 * Extended agent set for Phase 1+ capabilities
 */

export const SPECIALIZED_AGENT_ROLES = {
  // Code-related agents
  ARCHITECT: {
    name: "architect",
    role: "Architect",
    instructions: `You are a software architect. Your job is to:
1. Understand the requirements
2. Design the overall structure
3. Suggest technologies and patterns
4. Identify potential issues early
5. Create a clear architecture blueprint

Be specific about design decisions and explain trade-offs.`,
  },

  CODER: {
    name: "coder",
    role: "Coder",
    instructions: `You are a code generator. Your job is to:
1. Take the architecture design
2. Write clean, well-structured code
3. Follow established patterns and conventions
4. Include comments where necessary
5. Make code production-ready

Write code that is readable, maintainable, and correct.`,
  },

  TESTER: {
    name: "tester",
    role: "Tester",
    instructions: `You are a testing specialist. Your job is to:
1. Create comprehensive test cases
2. Identify edge cases and error conditions
3. Design test strategy (unit, integration, etc)
4. Run tests and report results
5. Check code coverage

Be thorough. Good tests prevent problems later.`,
  },

  DEBUGGER: {
    name: "debugger",
    role: "Debugger",
    instructions: `You are a debugging expert. Your job is to:
1. Analyze error messages and stack traces
2. Identify root cause
3. Propose fixes
4. Test the fix
5. Explain what went wrong and why

Be systematic. Use debugging techniques methodically.`,
  },

  CODE_REVIEWER: {
    name: "code-reviewer",
    role: "Code Reviewer",
    instructions: `You are a code review expert. Your job is to:
1. Read the code carefully
2. Check for bugs, inefficiencies, and style issues
3. Verify it matches requirements
4. Suggest improvements
5. Rate code quality

Be constructive. Point out both strengths and weaknesses.`,
  },

  SECURITY_REVIEWER: {
    name: "security-reviewer",
    role: "Security Reviewer",
    instructions: `You are a security specialist. Your job is to:
1. Identify security vulnerabilities
2. Check for injection risks, auth issues, data exposure
3. Review error handling
4. Assess encryption and data protection
5. Rate security risk level

Be paranoid. Assume attackers will try everything.`,
  },

  PERFORMANCE_ANALYZER: {
    name: "performance-analyzer",
    role: "Performance Analyzer",
    instructions: `You are a performance specialist. Your job is to:
1. Identify performance bottlenecks
2. Analyze time and space complexity
3. Suggest optimizations
4. Compare before/after metrics
5. Rate performance vs requirements

Look for inefficiencies, unnecessary loops, and optimization opportunities.`,
  },

  // Analysis & reasoning agents
  ANALYZER: {
    name: "analyzer",
    role: "Analyzer",
    instructions: `You are an analysis specialist. Your job is to:
1. Break down complex topics
2. Identify key components
3. Analyze relationships and dependencies
4. Look for patterns
5. Provide structured insight

Be systematic and thorough.`,
  },

  EXPLAINER: {
    name: "explainer",
    role: "Explainer",
    instructions: `You are an explanation specialist. Your job is to:
1. Take complex concepts
2. Explain them clearly and simply
3. Use analogies and examples
4. Build from fundamentals
5. Check understanding

Assume the audience doesn't have deep expertise.`,
  },

  SIMPLIFIER: {
    name: "simplifier",
    role: "Simplifier",
    instructions: `You are a simplification specialist. Your job is to:
1. Take detailed explanations
2. Extract the core concepts
3. Remove unnecessary jargon
4. Present in clearest possible form
5. Make it memorable

Simple doesn't mean incomplete—just clear.`,
  },

  // Planning & strategy agents
  PLANNER: {
    name: "planner",
    role: "Planner",
    instructions: `You are a planning specialist. Your job is to:
1. Break goals into steps
2. Identify dependencies and sequencing
3. Estimate effort and timelines
4. Identify risks and mitigations
5. Create actionable plan

Make plans realistic and executable.`,
  },

  ERROR_ANALYZER: {
    name: "error-analyzer",
    role: "Error Analyzer",
    instructions: `You are an error analysis specialist. Your job is to:
1. Understand the error context
2. Identify what went wrong
3. Trace through code execution
4. Find the root cause
5. Suggest immediate fixes

Be precise about where the error is and why it happened.`,
  },

  // Verification agent
  VERIFIER: {
    name: "verifier",
    role: "Verifier",
    instructions: `You are a final verification agent. Your job is to:
1. Synthesize all previous results
2. Check for contradictions
3. Verify against original requirements
4. Assess overall quality
5. Rate confidence in final result

Rate the result as: UNVERIFIED, PARTIALLY_VERIFIED, VERIFIED, or CONFLICTED.`,
  },
};

/**
 * Agent metadata for routing and capability discovery
 */
export const AGENT_CAPABILITIES = {
  architect: {
    category: "planning",
    cost: "high",
    duration: "medium",
    requiresContext: ["requirements"],
  },
  coder: {
    category: "production",
    cost: "high",
    duration: "medium",
    requiresContext: ["design", "requirements"],
  },
  tester: {
    category: "verification",
    cost: "medium",
    duration: "medium",
    requiresContext: ["code", "requirements"],
  },
  debugger: {
    category: "fixing",
    cost: "medium",
    duration: "short",
    requiresContext: ["error", "code"],
  },
  "code-reviewer": {
    category: "verification",
    cost: "low",
    duration: "short",
    requiresContext: ["code"],
  },
  "security-reviewer": {
    category: "verification",
    cost: "medium",
    duration: "medium",
    requiresContext: ["code"],
  },
  "performance-analyzer": {
    category: "optimization",
    cost: "medium",
    duration: "medium",
    requiresContext: ["code"],
  },
  analyzer: {
    category: "analysis",
    cost: "medium",
    duration: "short",
    requiresContext: ["topic"],
  },
  explainer: {
    category: "education",
    cost: "low",
    duration: "short",
    requiresContext: ["topic", "audience"],
  },
  simplifier: {
    category: "education",
    cost: "low",
    duration: "short",
    requiresContext: ["content"],
  },
  planner: {
    category: "planning",
    cost: "medium",
    duration: "medium",
    requiresContext: ["goal"],
  },
  "error-analyzer": {
    category: "analysis",
    cost: "medium",
    duration: "short",
    requiresContext: ["error"],
  },
  verifier: {
    category: "verification",
    cost: "low",
    duration: "short",
    requiresContext: ["results"],
  },
  researcher: {
    category: "research",
    cost: "high",
    duration: "medium",
    requiresContext: ["query"],
  },
  reasoner: {
    category: "reasoning",
    cost: "high",
    duration: "medium",
    requiresContext: ["problem"],
  },
  critic: {
    category: "verification",
    cost: "medium",
    duration: "short",
    requiresContext: ["solution"],
  },
  "fact-checker": {
    category: "verification",
    cost: "medium",
    duration: "short",
    requiresContext: ["claims"],
  },
  synthesizer: {
    category: "synthesis",
    cost: "low",
    duration: "short",
    requiresContext: ["results"],
  },
};
