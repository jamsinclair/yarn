/* @flow */

import type {Dependency} from '../../types.js';
import type {Reporter} from '../../reporters/index.js';
import type Config from '../../config.js';
import inquirer from 'inquirer';
import Lockfile from '../../lockfile/wrapper.js';
import {Add} from './add.js';
import {getOutdated} from './upgrade.js';

export const requireLockfile = true;

export function setFlags(commander: Object) {
  commander.usage('upgrade-interactive [flags]');
  commander.option('-S, --scope <scope>', 'upgrade packages under the specified scope');
  commander.option('--latest', 'list the latest version of packages, ignoring version ranges in package.json');
  commander.option('-E, --exact', 'install exact version. Only used when --latest is specified.');
  commander.option(
    '-T, --tilde',
    'install most recent release with the same minor version. Only used when --latest is specified.',
  );
  commander.option(
    '-C, --caret',
    'install most recent release with the same major version. Only used when --latest is specified.',
  );
}

export function hasWrapper(commander: Object, args: Array<string>): boolean {
  return true;
}

export async function run(config: Config, reporter: Reporter, flags: Object, args: Array<string>): Promise<void> {
  const outdatedFieldName = flags.latest ? 'latest' : 'wanted';
  const lockfile = await Lockfile.fromDirectory(config.lockfileFolder);

  const deps = await getOutdated(config, reporter, flags, lockfile, args);

  const maxLengthArr = {
    name: 'name'.length,
    current: 'from'.length,
    range: 'range'.length,
    [outdatedFieldName]: 'to'.length,
  };

  if (flags.latest) {
    maxLengthArr.range = 'latest'.length;
  }

  deps.forEach(dep =>
    ['name', 'current', 'range', outdatedFieldName].forEach(key => {
      maxLengthArr[key] = Math.max(maxLengthArr[key], dep[key].length);
    }),
  );

  // Depends on maxLengthArr
  const addPadding = dep => key => `${dep[key]}${' '.repeat(maxLengthArr[key] - dep[key].length)}`;
  const headerPadding = (header, key) =>
    `${reporter.format.bold.underline(header)}${' '.repeat(maxLengthArr[key] - header.length)}`;

  const colorizeName = ({current, wanted}) => (current === wanted ? reporter.format.yellow : reporter.format.red);

  const getNameFromHint = hint => (hint ? `${hint}Dependencies` : 'dependencies');

  const colorizeDiff = (from, to) => {
    const parts = to.split('.');
    const fromParts = from.split('.');

    const index = parts.findIndex((part, i) => part !== fromParts[i]);
    const splitIndex = index >= 0 ? index : parts.length;

    const colorized = reporter.format.green(parts.slice(splitIndex).join('.'));
    return parts.slice(0, splitIndex).concat(colorized).join('.');
  };

  const makeRow = dep => {
    const padding = addPadding(dep);
    const name = colorizeName(dep)(padding('name'));
    const current = reporter.format.blue(padding('current'));
    const latest = colorizeDiff(dep.current, padding(outdatedFieldName));
    const url = reporter.format.cyan(dep.url);
    const range = reporter.format.blue(flags.latest ? 'latest' : padding('range'));
    return `${name}  ${range}  ${current}  ❯  ${latest}  ${url}`;
  };

  const makeHeaderRow = () => {
    const name = headerPadding('name', 'name');
    const range = headerPadding('range', 'range');
    const from = headerPadding('from', 'current');
    const to = headerPadding('to', outdatedFieldName);
    const url = reporter.format.bold.underline('url');
    return `  ${name}  ${range}  ${from}     ${to}  ${url}`;
  };

  const groupedDeps = deps.reduce((acc, dep) => {
    const {hint, name, upgradeTo} = dep;
    const version = dep[outdatedFieldName];
    const key = getNameFromHint(hint);
    const xs = acc[key] || [];
    acc[key] = xs.concat({
      name: makeRow(dep),
      value: dep,
      short: `${name}@${version}`,
      upgradeTo,
    });
    return acc;
  }, {});

  const flatten = xs => xs.reduce((ys, y) => ys.concat(Array.isArray(y) ? flatten(y) : y), []);

  const choices = flatten(
    Object.keys(groupedDeps).map(key => [
      new inquirer.Separator(reporter.format.bold.underline.green(key)),
      new inquirer.Separator(makeHeaderRow()),
      groupedDeps[key],
      new inquirer.Separator(' '),
    ]),
  );

  try {
    const red = reporter.format.red('<red>');
    const yellow = reporter.format.yellow('<yellow>');
    reporter.info(reporter.lang('legendColorsForUpgradeInteractive', red, yellow));

    const answers: Array<Dependency> = await reporter.prompt('Choose which packages to update.', choices, {
      name: 'packages',
      type: 'checkbox',
      validate: answer => !!answer.length || 'You must choose at least one package.',
    });

    const getPattern = ({upgradeTo}) => upgradeTo;
    const isHint = x => ({hint}) => hint === x;

    await [null, 'dev', 'optional', 'peer'].reduce(async (promise, hint) => {
      // Wait for previous promise to resolve
      await promise;
      // Reset dependency flags
      flags.dev = hint === 'dev';
      flags.peer = hint === 'peer';
      flags.optional = hint === 'optional';

      const deps = answers.filter(isHint(hint)).map(getPattern);
      if (deps.length) {
        reporter.info(reporter.lang('updateInstalling', getNameFromHint(hint)));
        const add = new Add(deps, flags, config, reporter, lockfile);
        return add.init();
      }
      return Promise.resolve();
    }, Promise.resolve());
  } catch (e) {
    Promise.reject(e);
  }
}
