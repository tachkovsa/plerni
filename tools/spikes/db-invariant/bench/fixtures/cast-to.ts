// SPDX-License-Identifier: Apache-2.0
declare const query: { $castTo: <T>() => T };
query.$castTo<{ id: string }>();
