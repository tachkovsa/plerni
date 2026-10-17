// SPDX-License-Identifier: Apache-2.0
declare const eb: { ref: (name: string) => { as: (alias: string) => unknown } };
eb.ref('id').as('id');
