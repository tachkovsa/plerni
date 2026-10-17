// SPDX-License-Identifier: Apache-2.0
declare const query: { $narrowType: <T>() => T };
query.$narrowType<{ id: string }>();
