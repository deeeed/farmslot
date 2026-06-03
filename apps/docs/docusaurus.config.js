// @ts-check
const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Farmslot',
  tagline: 'A local operating system for supervised agentic engineering',
  favicon: 'img/favicon.svg',

  url: 'https://farmslot.io',
  baseUrl: '/',
  organizationName: 'farmslot',
  projectName: 'farmslot',

  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/deeeed/farmslot/tree/main/apps/docs/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/farmslot-social-card.svg',
      announcementBar: {
        id: 'active-development-preview',
        content:
          'Farmslot is in active development: expect experimental features, rough edges, changing APIs, and transient repo state.',
        backgroundColor: '#f59e0b',
        textColor: '#111827',
        isCloseable: false,
      },
      navbar: {
        title: 'Farmslot',
        logo: {
          alt: 'Farmslot FS logo',
          src: 'img/farmslot-logo.svg',
        },
        items: [
          { type: 'docSidebar', sidebarId: 'tutorialSidebar', position: 'left', label: 'Docs' },
          { to: '/docs/architecture/gateway', label: 'Architecture', position: 'left' },
          { to: '/docs/guides/adoption-path', label: 'Adoption', position: 'left' },
          { href: 'https://github.com/deeeed/farmslot', label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Why Farmslot?', to: '/docs/concepts/why-farmslot' },
              { label: 'Operating loop', to: '/docs/concepts/operating-loop' },
              { label: 'Gateway architecture', to: '/docs/architecture/gateway' },
            ],
          },
          {
            title: 'Project',
            items: [{ label: 'GitHub', href: 'https://github.com/deeeed/farmslot' }],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Farmslot contributors.`,
      },
      prism: {
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
};

module.exports = config;
