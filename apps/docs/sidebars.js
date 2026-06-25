// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Concepts',
      items: [
        'concepts/why-farmslot',
        'concepts/agentic-engineering-framework',
        'concepts/operating-loop',
        'concepts/vision',
        'concepts/recipe-evidence-loop',
        'concepts/recursive-feedback-loop',
      ],
    },
    {
      type: 'category',
      label: 'Products',
      items: [
        'products/command-center',
        'products/mobile-companion',
        'products/gateway-intelligence',
        'products/backlog-dispatch',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/gateway',
        'architecture/gateway-intelligence',
        'architecture/configurable-flows',
        'architecture/resource-management-and-streaming',
        'architecture/multi-node-security',
        'architecture/gateway-api-protocol',
        'architecture/recipe-harness',
        'architecture/protocol-boundaries',
      ],
    },
    {
      type: 'category',
      label: 'Deep dives',
      items: [
        'deep-dives/observability-interoperability',
        'deep-dives/tmux-multi-node',
        'deep-dives/runner-token-maxing',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/getting-started.generated',
        'guides/adoption-path',
        'guides/local-demo-and-cli',
        'guides/recipe-skills-adoption',
        'guides/import-a-project',
        'guides/project-type-onboarding',
        'guides/expo-project-integration',
        'guides/expo-recipe',
        'guides/headless-recipe',
        'guides/customize-worker-prompts',
        'guides/write-a-recipe',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/gateway-api',
        'reference/worker-signal-protocol',
        'reference/prepare-lifecycle',
        'reference/recipe-protocol-v1',
        'reference/recipe-runner-protocol',
        'reference/recipe-composition-quality',
      ],
    },
    'roadmap',
    {
      type: 'category',
      label: 'Legal',
      items: ['legal/privacy'],
    },
  ],
};

module.exports = sidebars;
