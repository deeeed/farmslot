import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import clsx from 'clsx';

import styles from './index.module.css';

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/deeeed/farmslot/main/install.sh | bash';

const operatingLoop = ['Dispatch', 'Watch', 'Steer', 'Validate', 'Review', 'Improve'];

const productPillars = [
  {
    title: 'Agentic engineering OS',
    body: 'Coordinate projects, machines, slots, runners, hooks, run state, artifacts, and memory as one operating environment.',
    to: '/docs/concepts/agentic-engineering-os',
  },
  {
    title: 'Watch-and-steer IDE',
    body: 'Use Command Center as the cockpit: live terminals, decisions, app state, artifacts, and intervention while the run is still moving.',
    to: '/docs/products/command-center',
  },
  {
    title: 'Proof-first trust layer',
    body: 'Validate visually and mechanically with recipes at the core: real actions, assertions, screenshots, traces, HUD intent, and proof artifacts.',
    to: '/docs/reference/recipe-protocol-v1',
  },
  {
    title: 'Project-type framework',
    body: 'Bring mobile apps, web apps, extensions, CLIs, services, desktop apps, and headless systems into the same operating loop.',
    to: '/docs/guides/project-type-onboarding',
  },
  {
    title: 'Runner capacity leverage',
    body: 'Turn multiple model runners, computers, and subscriptions into coordinated parallel engineering capacity.',
    to: '/docs/deep-dives/runner-token-maxing',
  },
  {
    title: 'Mobile supervision',
    body: 'Keep approvals, workers, runs, and terminals visible when you step away from the workstation.',
    to: '/docs/products/mobile-companion',
  },
  {
    title: 'Recursive improvement',
    body: 'Turn failures, flakes, and review comments into better prompts, docs, recipes, checks, and adapters for the next run.',
    to: '/docs/concepts/recursive-feedback-loop',
  },
];

const demoCards = [
  {
    title: 'Watch and steer a supervised run',
    status: 'Recipe-backed poster',
    image: '/img/demos/command-center-recipe-workspace.svg',
    alt: 'Recipe-backed Command Center workspace with stream, recipe controls, artifacts, and graph visible',
    body: 'Show dispatch, slot assignment, live stream visibility, recipe controls, and how the human reviews evidence before trusting the result.',
    provenance: 'Generated from docs/examples/recipes/farmslot/command-center-ui.recipe.json.',
  },
  {
    title: 'Recipe evidence run',
    status: 'Recipe-backed poster',
    image: '/img/demos/recipe-evidence-run.svg',
    alt: 'Recipe-backed live replay result with stream, runner logs, and generated artifacts',
    body: 'Show a recipe run turning setup, real actions, visual validation, assertions, and proof artifacts into review evidence.',
    provenance: 'Generated from docs/examples/recipes/farmslot/recipe-player-e2e.recipe.json.',
  },
  {
    title: 'Project-type framework',
    status: 'Video fallback',
    image: '/img/demos/project-type-framework.svg',
    alt: 'Recipe-backed poster showing Audiolab and EchoBridge as public demo project integrations',
    body: 'Show the same operating loop across approved public demo targets while keeping private work projects out of launch media.',
    provenance:
      'Generated from the demo media script and backed by Audiolab/EchoBridge Recipe v1 runners.',
  },
  {
    title: 'Companion mobile supervision',
    status: 'Recipe-backed poster',
    image: '/img/demos/mobile-companion-artifacts.svg',
    alt: 'Recipe-backed mobile companion evidence review screen',
    body: 'Show the operator checking workers, terminal status, and run progress from the mobile companion without losing control.',
    provenance: 'Generated from docs/examples/recipes/farmslot/mobile-companion.recipe.json.',
    portrait: true,
  },
];

const feedbackSteps = [
  ['Run', 'Execute in an isolated slot with live logs, artifacts, and human decision gates.'],
  ['Observe', 'Capture terminal streams, screenshots, traces, summaries, and reviewer notes.'],
  ['Review', 'Use humans and independent model reviewers to find gaps before merging.'],
  ['Retrospect', 'Convert failures, flakes, and repeated review comments into curated learnings.'],
  [
    'Curate',
    'Keep only reusable lessons that can become checks, prompts, recipes, docs, or adapters.',
  ],
  ['Improve', 'Update prompts, recipes, docs, and project adapters before the next run.'],
];

function HomepageHeader() {
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={clsx('container', styles.heroGrid)}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Farmslot</span>
          <Heading as="h1" className={styles.heroTitle}>
            Your OS and IDE for scaling agentic engineering work.
          </Heading>
          <p className={styles.heroSubtitle}>
            Run many agents across many project types, computers, and model subscriptions. Watch and
            steer them while they work, then trust the result through visual validation, executable
            recipes, and proof artifacts instead of final claims.
          </p>
          <div className={styles.heroInstall} aria-label="One-line installer">
            <CodeBlock language="bash">{INSTALL_COMMAND}</CodeBlock>
            <span className={styles.heroInstallHint}>
              One command — checks prerequisites, sets up the workspace, ends with a green{' '}
              <code>farmslot doctor</code>.
            </span>
          </div>
          <div className={styles.buttons}>
            <Link className="button button--secondary button--lg" to="/docs/guides/getting-started">
              Get started
            </Link>
            <Link
              className={clsx(
                'button button--outline button--secondary button--lg',
                styles.heroOutlineButton,
              )}
              to="/docs/intro"
            >
              Read the docs
            </Link>
            <Link
              className={clsx(
                'button button--outline button--secondary button--lg',
                styles.heroOutlineButton,
              )}
              to="/docs/guides/adoption-path"
            >
              Adopt incrementally
            </Link>
          </div>
        </div>
        <div className={styles.heroPanel} aria-label="Farmslot operating loop preview">
          <div className={styles.heroPanelHeader}>
            <span>Watch-and-steer loop</span>
            <strong>Demo-ready</strong>
          </div>
          <img
            className={styles.heroPoster}
            src="/img/demos/recipe-evidence-run.svg"
            alt="Recipe-backed poster preview of the Farmslot recipe evidence loop"
          />
          <div className={styles.loopRow} aria-label="Operating loop steps">
            {operatingLoop.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

function LatestAdditions() {
  return (
    <section className="homepage-section">
      <div className="container">
        <div className={styles.developmentNotice}>
          <strong>Active development preview</strong>
          <span>
            Farmslot is moving quickly while the product is finalized in one repo. Experimental
            features, large/transient files, APIs, runner contracts, fixtures, and docs may change
            while the project matures.
          </span>
        </div>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionEyebrow}>Why it matters</span>
          <Heading as="h2">Scale your own workflow without losing trust.</Heading>
          <p>
            Farmslot is the product layer around agents: a framework for many project types, an OS
            for coordinating the fleet, an IDE for watching and steering work, and a proof-first
            recipe layer for visually and mechanically validating the result.
          </p>
        </div>
        <div className={styles.cardGrid}>
          {productPillars.map((item) => (
            <Link className={styles.featureCard} key={item.title} to={item.to}>
              <Heading as="h3">{item.title}</Heading>
              <p>{item.body}</p>
              <span>Open docs →</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function DemoSection() {
  return (
    <section className={clsx('homepage-section', styles.demoSection)}>
      <div className="container">
        <div className={styles.sectionHeader}>
          <span className={styles.sectionEyebrow}>Demo plan</span>
          <Heading as="h2">Each short clip should explain one product promise.</Heading>
          <p>
            The best demos are reproducible feature explainers: dispatch real work, watch and steer
            it live, validate with recipes, review the evidence, and regenerate the screenshots or
            clips from the same proof path.
          </p>
        </div>
        <div className={styles.demoGrid}>
          {demoCards.map((demo) => (
            <article
              className={clsx(styles.demoCard, demo.portrait && styles.demoCardPortrait)}
              key={demo.title}
            >
              <div className={styles.posterFrame}>
                <img src={demo.image} alt={demo.alt} loading="lazy" />
                <span className={styles.videoBadge}>{demo.status}</span>
              </div>
              <div className={styles.demoCardBody}>
                <div className={styles.demoMeta}>{demo.status}</div>
                <Heading as="h3">{demo.title}</Heading>
                <p>{demo.body}</p>
                <small className={styles.demoProvenance}>{demo.provenance}</small>
              </div>
            </article>
          ))}
        </div>
        <div className={styles.inlineCallout}>
          <span>Recording checklist</span>
          <p>
            These cards now use recipe-backed public-safe poster frames. Short videos can replace
            them later when recipe-level video capture is available; until then the poster is the
            documented fallback.
          </p>
          <Link to="/docs/guides/demo-recording-plan">View recording plan →</Link>
        </div>
      </div>
    </section>
  );
}

function FeedbackLoop() {
  return (
    <section className="homepage-section">
      <div className="container">
        <div className={styles.loopLayout}>
          <div>
            <span className={styles.sectionEyebrow}>Recursive feedback</span>
            <Heading as="h2">Every run should make the next run better.</Heading>
            <p className={styles.largeText}>
              Farmslot treats validation and retrospectives as part of the product loop. Runs create
              evidence, review finds gaps, retrospectives capture durable lessons, and those lessons
              improve recipes, prompts, docs, and adapters.
            </p>
            <Link className="button button--primary" to="/docs/concepts/recursive-feedback-loop">
              Read the feedback loop
            </Link>
          </div>
          <ol className={styles.feedbackList}>
            {feedbackSteps.map(([title, body]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{body}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function DocsCallout() {
  return (
    <section className={styles.calloutSection}>
      <div className={clsx('container', styles.callout)}>
        <div>
          <Heading as="h2">Start small, then deepen the contract.</Heading>
          <p>
            Import a project with hooks, add a runner manifest, adopt recipes where behavior needs
            proof, then use retrospectives to keep improving the system.
          </p>
        </div>
        <div className={styles.calloutButtons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/guides/project-type-onboarding"
          >
            Project onboarding
          </Link>
          <Link
            className="button button--outline button--primary button--lg"
            to="/docs/reference/recipe-runner-protocol"
          >
            Runner protocol
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="Agentic engineering OS and IDE"
      description="Farmslot is a personal dev-agent OS and IDE for scaling work across projects, machines, and model runners with visual validation, executable recipes, and proof artifacts"
    >
      <HomepageHeader />
      <main>
        <LatestAdditions />
        <DemoSection />
        <FeedbackLoop />
        <DocsCallout />
      </main>
    </Layout>
  );
}
