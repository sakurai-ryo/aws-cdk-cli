# CDK CLI integration test
<!--BEGIN STABILITY BANNER-->

---

![cdk-constructs: Stable](https://img.shields.io/badge/cdk--constructs-stable-success.svg?style=for-the-badge)

---

<!--END STABILITY BANNER-->

This package contains CDK CLI integration test suites, as well as helper tools necessary to run those suites against various different distributions of the CDK (in the source repository, against a build directory, or against published releases).

> The tools and tests themselves should arguably be in different packages, but I want to prevent package proliferation. For now we'll keep them together.

## Tests

The tests themselves are in the `tests/` directory:

```text
tests/
├── cli-integ-tests
├── init-csharp
├── init-fsharp
├── init-java
├── init-javascript
├── init-python
├── init-typescript-app
├── init-typescript-lib
├── init-go
└── uberpackage
```

Each subdirectory contains one test **suite**, and in the development pipeline each suite is run individually in a CodeBuild job, all in parallel. This requires manual configuration in the pipeline: to add a new suite, first add a suite here, then add the suite to the pipeline as well. The safest strategy is to add a trivially succeeding suite first (for example, a single test with `expect(true).toBeTruthy()`), add it to the pipeline, and then write the actual tests.

Test suites are written as a collection of Jest tests, and they are run using Jest, using the code in the `lib/` directory as helpers.

### Components under test

The tests have their own version, and can test other components at multiple versions. The following components can be injected,
and will default to the latest published version if not supplied.

Because many tests are very different, there is no generalized mechanism to
inject these dependencies into tests. Users can specify component versions, but
Test Authors are responsible for taking these parameters and using it to set up
the right environment for the tests.

| Component             | Command-line argument                | Default     | Treatment by runner        | Treatment in test                             |
|-----------------------|--------------------------------------|-------------|----------------------------|-----------------------------------------------|
| CDK Construct Library | `--framework-version=VERSION`        | Latest      | Nothing                    | `npm install` into temporary project dir.     |
| CDK CLI               | `--cli-version=VERSION`              | Auto source | `npm install` into tempdir | Add to `$PATH`.                               |
|                       | `--cli-source=ROOT` or `auto`        | Auto source |                            | Add `<ROOT>/packages/aws-cdk/bin` to `$PATH`. |
| Toolkit Library       | `--toolkit-lib-version=VERSION`      | Devdep      | Install into its own deps  | Nothing

### Running a test suite

You run a suite using the `bin/run-suite` tool. You must select either a version of the CLI and framework which can be `npm install`ed, or point to the root of the source tree:

```shell
# Automatically determine the source tree root
$ bin/run-suite <SUITE_NAME>

# Use the CLI from the given repo
$ bin/run-suite --cli-source=/path/to/repo-root <SUITE_NAME>

# Run against a released version
$ bin/run-suite --cli-version=2.34.5 <SUITE_NAME>

# Run against a specific framework version
$ bin/run-suite --framework-version=2.34.5 <SUITE_NAME>
```

To run a specific test, add `-t` and a substring of the test name. For example:

```shell
bin/run-suite -a cli-integ-tests -t 'load old assemblies'
```

### Running a test suite against binaries

The test suites that run the "init tests" require actual packages staged in CodeArtifact repositories to run. This requires you to do a full build, then create a CodeArtifact repository in your own account, uploading the packages there, and then running the tests in a shell configured to have NPM, Pip, Maven etc look for those packages in CodeArtifact.

```shell
# Build and pack all of CDK (in the `aws-cdk` repo, will take ~an hour)
$ ./build.sh
$ ./pack.sh

# Use publib to upload to CodeArtifact
$ npm install -g publib
# publib-ca is a CLI tool that comes with publib
$ publib-ca create
$ publib-ca publish /path/to/dist

# Run the tests against those repositories (may need to substitute 0.0.0 w/ local number)
$ source ~/.publib-ca/usage/activate.bash
$ bin/run-suite --use-cli-release=0.0.0 <SUITE_NAME>

# Clean up
$ publib-ca delete
```

### Running tests with debugger

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "args": ["-a", "cli-integ-tests", "-t", "context in stage propagates to top"],
      "name": "debug integ tests",
      "program": "~/aws-cdk/packages/@aws-cdk-testing/cli-integ/bin/run-suite",
      "console": "integratedTerminal",
      "sourceMaps": true,
      "skipFiles": [ "<node_internals>/**/*" ],
      "stopOnEntry": false
    }
  ]
}
```

1. Assuming you checked out the `aws-cdk` repository in your `~` directory, use the above `launch.json`.
2. In the `"args"` value after `"-t"`, place the name of the test that you'd like to run.
3. Press the VS code green arrow to launch the debugger.

### Running during PRs

Integration tests are executed automatically during PRs. Every workflow run generates a markdown summary
of the suite, detailing which tests passed/failed, and some additional statistics.

> For exmaple: https://github.com/aws/aws-cdk-cli/actions/runs/15305859516

To debug a failing test, navigate to the execution logs and search for the name of the test. 
You'll find a verbose log that displays all operations taken during the test.

Unlike running locally, PRs make use of the *Atmosphere* service, an internal CDK service designed 
to provide integration tests with clean AWS environments. It allows us to run many concurrent tests, 
and significantly reduce suite durations. Most of the time, *Atmosphere* should be transparent to you, 
but sometimes, tests that pass locally may fail during PRs because of additional restrictions 
it imposes:

- **Service Control Policy (SCP):** AWS environments (i.e accounts) are subject to an SCP that denies access 
to specific services. For example, you might see a failure similar to:

   ```
   User: arn:aws:sts::111111111111:assumed-role/cdk-hnb659fds-cfn-exec-role-111111111111-eu-central-1/AWSCloudFormation is not authorized to perform: logs:CreateLogGroup on resource: arn:aws:logs:eu-central-1:111111111111:log-group:/aws/lambda/cdktest-00cyqupxno939-imp-cdkimportnodejslambdates-6X36hssZOiZk:log-stream: with an explicit deny in a service control policy
   ```
  This means that your PR introduces a need to invoke a new service, or deploy a new type of resource, that wasn't previously required. When this happens - reach out to a maintainer through the PR. They will evaluate if the new requirement is justified, and grant the necessary permissions.

## Tools

There are a number of tools in the `bin/` directory. They are:

```text
bin/
├── apply-patches
├── query-github
├── run-suite
├── stage-distribution
└── test-root
```

* `apply-patches`: used for regression testing. Applies patches to historical versions of the tests to fix false positive test failures.
* `query-github`: used for regression testing. Queries GitHub for previously released versions.
* `run-suite`: run one of the test suites in the `tests/` directory.
* `stage-distribution`: used for testing in the pipeline. Uploads candidate release binaries to CodeArtifact so that they can be installed using `npm install`, `pip install`, etc.
* `test-root`: return the directory containing all tests (used for applying patches).

## Regression testing

The regression testing mechanism is somewhat involved and therefore deserves its own section. The principle is not too hard to explain though:

*We run the previous version of the CLI integ tests against the new candidate release of the CLI, to make sure we didn't accidentally introduce any breaking behavior*.

This is slightly complicated by two facts:

* (1) Both the CLI and the framework may have changed, and an incompatibility may have arisen between the framework and CLI. Newer CLIs must always support older framework versions. We therefore run two flavors of the integration tests:
  * Old tests, new CLI, new framework
  * Old tests, new CLI, old framework

The testing matrix looks like this:

```text
                 OLD TESTS                             NEW TESTS

                    CLI                                   CLI
                Old    New                            Old    New
            ┌────────┬────────┐                   ┌────────┬────────┐
     F'WORK │  prev  │        │            F'WORK │        │        │
        Old │  rls   │  regr  │               Old │ (N/A)  │   ?    │
            │ integ  │        │                   │        │        │
            ├────────┼────────┤                   ├────────┼────────┤
            │        │        │                   │        │  cur   │
        New │ (N/A)  │  regr  │               New │ (N/A)  │  rls   │
            │        │        │                   │        │ integ  │
            └────────┴────────┘                   └────────┴────────┘
```

We are covering everything except "new tests, new CLI, old framework", which is not clear that it even makes sense to test because some new features may rely on framework support which will not be in the old version yet.

* (2) Sometimes, old tests will fail on newer releases when we introduce breaking changes to the framework or CLI for something serious (such as security reasons), or maybe because we had a bug in an old version that happened to pass, but now the test needs to be updated in order to pass a bugfix.

For this case we have a patching mechanism, so that in a NEW release of the tools, we include files that are copied over an OLD release of the test, that allows them to pass. For the simplest case there is a mechanism to suppress the run of a single test, so that we can skip the running of one test for one release. For more complicated cases we copy in patched `.js` source files which will replace old source files. (Patches are considered part of the *tools*, not part of the *tests*).

### Mechanism

To run the tests in a regressory fashion, do the following:

* Download the current `@aws-cdk-testing/cli-integ` artifact at `V1`.
* Determine the previous version `V0` (use `query-github` for this).
* Download the previous `@aws-cdk-testing/cli-integ` artifact at `V0`.
* From the `V1` artifact, apply the `V0` patch set.
* Run the `V0` tests with the `--framework-version` option:

```shell
# Old tests, new CLI, new framework
V0/bin/run-suite --use-cli-release=V1 --framework-version=V1 [...]

# Old tests, new CLI, old framework
V0/bin/run-suite --use-cli-release=V1 --framework-version=V0 [...]
```

### Patching

To patch a previous set of tests to make them pass with a new release, add a directory to `resources/cli-regression-patches`. The simplest method is to add a `skip-tests.txt` file:

```shell
# The version of the tests that are currently failing (V0 in the paragraph above)
export VERSION=X.Y.Z

mkdir -p resources/cli-regression-patches/v${VERSION}
cp skip-tests.txt resources/cli-regression-patches/v${VERSION}/
```

Now edit `resources/cli-regression-patches/vX.Y.Z/skip-tests.txt` and put the name of the test you want to skip on a line by itself.

If you need to replace source files, it's probably best to stick compiled `.js` files in here. `.ts` source files wouldn't compile because they'd be missing `imports`.
