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

const commandCenterDemo = {
  title: 'Command Center parallel watch-and-steer',
  status: 'Real recipe video',
  poster: '/img/demos/command-center-parallel-watch.png',
  video: '/videos/demos/command-center-parallel-watch.mp4',
  alt: 'Command Center monitoring multiple Farmslot runs in parallel terminal panes',
  body: 'Command Center gives you a live cockpit for parallel agent work: see each slot, watch terminals move, steer a run before it drifts, and keep enough context to make a decision while the work is still active.',
};

const gatewayIntelligenceDemo = {
  title: 'Gateway intelligence from Command Center',
  status: 'Real recipe video',
  poster: '/img/demos/command-center-gateway-intelligence.png',
  video: '/videos/demos/command-center-gateway-intelligence.mp4',
  alt: 'Command Center showing gateway intelligence answering a fleet status question',
  body: 'Gateway intelligence turns fleet state into an operator assistant: ask what is running, which slots need attention, or where proof artifacts live without manually scanning every terminal and run card.',
};

const humanReadyGateDemo = {
  title: 'Human ready gate',
  status: 'Real Command Center screenshot',
  image: '/img/demos/command-center-human-ready-gate.png',
  alt: 'Command Center ready workspace showing a human approval gate with package evidence, recipe artifacts, quality checks, and approve or extra-review actions',
  body: 'Ready gates make agent output reviewable before it becomes your code: inspect the package, app behavior, validation results, diff, and quality checks, then approve, request another review, or send feedback to keep steering.',
};

const recipeEvidenceDemo = {
  title: 'Recipe evidence validation loop',
  status: 'Validation trail',
  image: '/img/demos/recipe-evidence-validation-loop.png',
  alt: 'Validation board assembled from recipe summary, trace, and artifact manifest files',
  body: 'Recipes make validation repeatable: instead of trusting a final claim, you can replay the actions, assertions, screenshots, videos, traces, summaries, and manifests behind the result.',
};

const projectTypeMatrixDemo = {
  title: 'Project-type framework',
  status: 'Concept diagram',
  image: '/img/demos/project-type-validation-matrix.svg?v=20260612b',
  alt: 'Labeled architecture diagram showing how mobile apps, web apps, CLIs, services, desktop apps, and headless systems fit into one Farmslot proof loop',
  body: 'Farmslot is not tied to one stack. Model each project type with hooks, resources, and recipes, then supervise them through the same dispatch, validation, review, and retrospective loop.',
};

const companionSupervisionDemo = {
  title: 'Companion mobile supervision',
  status: 'Real app screenshot',
  image: '/img/demos/companion-mobile-supervision.png',
  portrait: true,
  alt: 'Farmslot Companion mobile app showing active runs with evidence, recipe, diff, slot, and terminal actions',
  body: 'The Companion app keeps the operating loop available away from the workstation: check active runs, inspect proof artifacts, see slot and terminal state, and stay close to approvals when you step away.',
};

const demoItems = [
  commandCenterDemo,
  gatewayIntelligenceDemo,
  humanReadyGateDemo,
  recipeEvidenceDemo,
  companionSupervisionDemo,
  projectTypeMatrixDemo,
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
              One command — checks prerequisites, sets up the workspace, ends with a{' '}
              <span className={styles.noWrap}>
                green <code>farmslot doctor</code>
              </span>
              .
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
          <video
            className={styles.heroPoster}
            src={commandCenterDemo.video}
            poster={commandCenterDemo.poster}
            aria-label={commandCenterDemo.alt}
            autoPlay
            loop
            muted
            playsInline
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
            features, large/transient files, APIs, runner contracts, and docs may change while the
            project matures.
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
          <span className={styles.sectionEyebrow}>Capabilities</span>
          <Heading as="h2">What Farmslot helps you operate.</Heading>
          <p>
            These examples show what Farmslot lets you do: coordinate active agent work, turn
            validation into reusable proof, and supervise different project types through one
            operating loop. The same workflow scales from live terminals to review gates, mobile
            supervision, and repeatable validation.
          </p>
        </div>
        <div className={styles.demoShowcase}>
          {demoItems.map((demo) => (
            <article className={styles.featuredDemoCard} key={demo.title}>
              <div className={styles.featuredPosterFrame}>
                {'video' in demo ? (
                  <video
                    className={clsx(styles.demoVideo, demo.portrait && styles.portraitDemo)}
                    src={demo.video}
                    poster={demo.poster}
                    aria-label={demo.alt}
                    controls
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img
                    className={styles.demoVideo}
                    src={demo.image}
                    alt={demo.alt}
                    loading="eager"
                  />
                )}
                <span className={styles.videoBadge}>{demo.status}</span>
              </div>
              <div className={styles.demoCardBody}>
                <div className={styles.demoMeta}>{demo.status}</div>
                <Heading as="h3">{demo.title}</Heading>
                <p>{demo.body}</p>
              </div>
            </article>
          ))}
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
