import {
  Scalar,
  sqlEscapeString,
  ColumnExtendExp,
  col,
  constVal,
  defaultDialect,
} from "./defs";
import { FilterExp, BinRelExp, UnaryRelExp } from "./FilterExp";
import { SQLDialect } from "./dialect";
import { ColumnType } from "./ColumnType";
import { Schema, ColumnMetadata } from "./Schema";
import _ = require("lodash");
import { TableInfoMap, TableRep } from "./TableRep";
import { ppSQLQuery } from "./pp";
import {
  SQLQueryAST,
  mkColSelItem,
  SQLSelectAST,
  SQLSelectListItem,
  getColId,
  SQLValExp,
  SQLFromQuery,
  SQLFromJoin,
  mkAggExp,
  mkSubSelectList,
} from "./SQLQuery";
import { AggFn } from "./AggFn";

type QueryOp =
  | "table"
  | "project"
  | "filter"
  | "groupBy"
  | "mapColumns"
  | "mapColumnsByIndex"
  | "concat"
  | "sort"
  | "extend"
  | "join";

// An AggColSpec is either a column name (for default aggregation based on column type
// or a pair of column name and AggFn
export type AggColSpec = string | [AggFn, string];

export const typeIsNumeric = (ct: ColumnType): boolean => ct.isNumeric;

export const typeIsString = (ct: ColumnType): boolean => ct.isString;

/*
 * generate a SQL literal for the given value based on its
 * column type.
 *
 * Will need work if we enrich the column type system.
 */

export const sqlLiteralVal = (ct: ColumnType, jsVal: any): string => {
  let ret;

  if (jsVal == null) {
    ret = "null";
  } else {
    ret = ct.isString ? sqlEscapeString(jsVal) : jsVal.toString();
  }

  return ret;
};

/*
 * Could almost use an intersection type of {id,type} & ColumnMetadata, but
 * properties are all optional here
 */

export type ColumnMapInfo = {
  id?: string;
  displayName?: string;
};

export type ColumnExtendOptions = {
  displayName?: string;
  type?: ColumnType;
};

interface TableQueryRep {
  operator: "table";
  tableName: string;
}
interface ProjectQueryRep {
  operator: "project";
  cols: string[];
  from: QueryRep;
}
interface GroupByQueryRep {
  operator: "groupBy";
  cols: string[];
  aggs: AggColSpec[];
  from: QueryRep;
}
interface FilterQueryRep {
  operator: "filter";
  fexp: FilterExp;
  from: QueryRep;
}
interface MapColumnsQueryRep {
  operator: "mapColumns";
  cmap: { [colName: string]: ColumnMapInfo };
  from: QueryRep;
}
interface MapColumnsByIndexQueryRep {
  operator: "mapColumnsByIndex";
  cmap: { [colIndex: number]: ColumnMapInfo };
  from: QueryRep;
}
interface ConcatQueryRep {
  operator: "concat";
  target: QueryRep;
  from: QueryRep;
}
interface SortQueryRep {
  operator: "sort";
  keys: [string, boolean][];
  from: QueryRep;
}
interface ExtendQueryRep {
  operator: "extend";
  colId: string;
  colExp: ColumnExtendExp;
  opts: ColumnExtendOptions;
  from: QueryRep;
}
// Join types:  For now: only left outer
export type JoinType = "LeftOuter";
interface JoinQueryRep {
  operator: "join";
  rhs: QueryRep;
  on: string | string[];
  joinType: JoinType;
  lhs: QueryRep;
}
type QueryRep =
  | TableQueryRep
  | ProjectQueryRep
  | GroupByQueryRep
  | FilterQueryRep
  | MapColumnsQueryRep
  | MapColumnsByIndexQueryRep
  | ConcatQueryRep
  | SortQueryRep
  | ExtendQueryRep
  | JoinQueryRep;

// A QueryExp is the builder interface we export from reltab.
// The only things clients of the interface can do with a QueryExp are chain it
// to produce new queries, or pass it to functions like Connection.query()
export class QueryExp {
  expType: "QueryExp";
  private readonly _rep: QueryRep;

  constructor(rep: QueryRep) {
    this.expType = "QueryExp";
    this._rep = rep;
  }

  // operator chaining methods:
  project(cols: Array<string>): QueryExp {
    return new QueryExp({ operator: "project", cols, from: this._rep });
  }
  groupBy(cols: string[], aggs: AggColSpec[]): QueryExp {
    return new QueryExp({ operator: "groupBy", cols, aggs, from: this._rep });
  }

  filter(fexp: FilterExp): QueryExp {
    return new QueryExp({ operator: "filter", fexp, from: this._rep });
  }

  mapColumns(cmap: { [colName: string]: ColumnMapInfo }): QueryExp {
    return new QueryExp({ operator: "mapColumns", cmap, from: this._rep });
  }

  mapColumnsByIndex(cmap: { [colIndex: number]: ColumnMapInfo }): QueryExp {
    return new QueryExp({
      operator: "mapColumnsByIndex",
      cmap,
      from: this._rep,
    });
  }

  concat(qexp: QueryExp): QueryExp {
    return new QueryExp({
      operator: "concat",
      target: qexp._rep,
      from: this._rep,
    });
  }

  sort(keys: Array<[string, boolean]>): QueryExp {
    return new QueryExp({ operator: "sort", keys, from: this._rep });
  }

  // extend by adding a single column
  // TODO: Should probably use a distinct type from ColumnMapInfo where
  // type is mandatory:
  extend(
    colId: string,
    colExp: ColumnExtendExp,
    opts: ColumnExtendOptions = {}
  ): QueryExp {
    return new QueryExp({
      operator: "extend",
      colId,
      colExp,
      opts,
      from: this._rep,
    });
  }

  // join to another QueryExp
  join(
    rhs: QueryExp,
    on: string | Array<string>,
    joinType: JoinType = "LeftOuter"
  ): QueryExp {
    return new QueryExp({
      operator: "join",
      joinType,
      on,
      rhs: rhs._rep,
      lhs: this._rep,
    });
  }

  // distinct values of a column
  // just a degenerate groupBy:
  distinct(col: string): QueryExp {
    return this.groupBy([col], []);
  }

  toSql(
    dialect: SQLDialect,
    tableMap: TableInfoMap,
    offset: number = -1,
    limit: number = -1
  ): string {
    return ppSQLQuery(
      dialect,
      queryToSql(dialect, tableMap, this._rep),
      offset,
      limit
    );
  }

  toCountSql(dialect: SQLDialect, tableMap: TableInfoMap): string {
    return ppSQLQuery(
      dialect,
      queryToCountSql(dialect, tableMap, this._rep),
      -1,
      -1
    );
  }

  getSchema(dialect: SQLDialect, tableMap: TableInfoMap): Schema {
    return getQuerySchema(dialect, tableMap, this._rep);
  }
}

const reviverMap = {
  ColRef: (v: any) => col(v.colName),
  ConstVal: (v: any) => constVal(v.val),
  BinRelExp: (v: any) => new BinRelExp(v.op, v.lhs, v.rhs),
  UnaryRelExp: (v: any) => new UnaryRelExp(v.op, v.arg),
  FilterExp: (v: any) => new FilterExp(v.op, v.opArgs),
  QueryExp: (v: any) => new QueryExp(v._rep),
};

export const queryReviver = (key: string, val: any): any => {
  let retVal = val;

  if (val != null) {
    if (typeof val === "object") {
      const rf: (val: any) => any | undefined = (reviverMap as any)[
        val.expType
      ];

      if (rf) {
        retVal = rf(val);
      } else {
        if (val.hasOwnProperty("expType")) {
          // should probably throw...
          console.warn("*** no reviver found for expType ", val.expType);
        }
      }
    }
  }

  return retVal;
};

type QueryReq = {
  query: QueryExp;
  filterRowCount: number;
  offset?: number;
  limit?: number;
};
export const deserializeQueryReq = (jsonStr: string): QueryReq => {
  const rq = JSON.parse(jsonStr, queryReviver);
  return rq;
};

const tableRepReviver = (key: string, val: any): any => {
  let retVal = val;

  if (key === "schema") {
    retVal = new Schema(val.columns, val.columnMetadata);
  }

  return retVal;
};

export const deserializeTableRepStr = (jsonStr: string): TableRep => {
  const rt = JSON.parse(jsonStr, tableRepReviver);
  return rt;
};

// deserialize already decoded JSON:
export const deserializeTableRepJson = (json: any): TableRep => {
  const tableRepJson = json["tableRep"];
  const schemaJson = tableRepJson["schema"];
  const schema = new Schema(schemaJson.columns, schemaJson.columnMetadata);
  const tableRep = new TableRep(schema, tableRepJson.rowData);
  return tableRep;
};

const tableGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: TableQueryRep
): Schema => {
  return tableMap[query.tableName].schema;
};

const projectGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: ProjectQueryRep
): Schema => {
  const inSchema = getQuerySchema(dialect, tableMap, query.from);
  const { cols } = query;
  return new Schema(cols, _.pick(inSchema.columnMetadata, cols));
};

const groupByGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: GroupByQueryRep
): Schema => {
  const { cols, aggs } = query;
  const aggCols: Array<string> = aggs.map((aggSpec: string | string[]) =>
    typeof aggSpec === "string" ? aggSpec : aggSpec[1]
  );
  const inSchema = getQuerySchema(dialect, tableMap, query.from);
  const rs = new Schema(cols.concat(aggCols), inSchema.columnMetadata);
  return rs;
};

const filterGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { from }: { from: QueryRep }
): Schema => {
  const inSchema = getQuerySchema(dialect, tableMap, from);
  return inSchema;
};

const mapColumnsGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: MapColumnsQueryRep
): Schema => {
  const { cmap, from } = query;
  // TODO: check that all columns are columns of original schema,
  // and that applying cmap will not violate any invariants on Schema....but need to nail down
  const inSchema = getQuerySchema(dialect, tableMap, query.from);

  let outColumns = [];
  let outMetadata: { [cid: string]: ColumnMetadata } = {};

  for (let i = 0; i < inSchema.columns.length; i++) {
    let inColumnId = inSchema.columns[i];
    let inColumnInfo = inSchema.columnMetadata[inColumnId];
    let cmapColumnInfo = cmap[inColumnId];

    if (typeof cmapColumnInfo === "undefined") {
      outColumns.push(inColumnId);
      outMetadata[inColumnId] = inColumnInfo;
    } else {
      let outColumnId = cmapColumnInfo.id;

      if (typeof outColumnId === "undefined") {
        outColumnId = inColumnId;
      } // Form outColumnfInfo from inColumnInfo and all non-id keys in cmapColumnInfo:

      let outColumnInfo = JSON.parse(JSON.stringify(inColumnInfo));

      for (let key in cmapColumnInfo) {
        if (key !== "id" && cmapColumnInfo.hasOwnProperty(key)) {
          outColumnInfo[key] = (cmapColumnInfo as any)[key];
        }
      }

      outMetadata[outColumnId] = outColumnInfo;
      outColumns.push(outColumnId);
    }
  }

  const outSchema = new Schema(outColumns, outMetadata);
  return outSchema;
};

const mapColumnsByIndexGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { cmap, from }: MapColumnsByIndexQueryRep
): Schema => {
  // TODO: try to unify with mapColumns; probably have mapColumns do the
  // mapping to column indices then call this
  const inSchema = getQuerySchema(dialect, tableMap, from);

  var outColumns = [];
  var outMetadata: { [cid: string]: ColumnMetadata } = {};

  for (var inIndex = 0; inIndex < inSchema.columns.length; inIndex++) {
    var inColumnId = inSchema.columns[inIndex];
    var inColumnInfo = inSchema.columnMetadata[inColumnId];
    var cmapColumnInfo = cmap[inIndex];

    if (typeof cmapColumnInfo === "undefined") {
      outColumns.push(inColumnId);
      outMetadata[inColumnId] = inColumnInfo;
    } else {
      var outColumnId = cmapColumnInfo.id;

      if (typeof outColumnId === "undefined") {
        outColumnId = inColumnId;
      } // Form outColumnfInfo from inColumnInfo and all non-id keys in cmapColumnInfo:

      var outColumnInfo = JSON.parse(JSON.stringify(inColumnInfo));

      for (var key in cmapColumnInfo) {
        if (key !== "id" && cmapColumnInfo.hasOwnProperty(key)) {
          outColumnInfo[key] = (cmapColumnInfo as any)[key];
        }
      }

      outMetadata[outColumnId] = outColumnInfo;
      outColumns.push(outColumnId);
    }
  }

  var outSchema = new Schema(outColumns, outMetadata);
  return outSchema;
};

const concatGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { from }: ConcatQueryRep
): Schema => {
  const inSchema = getQuerySchema(dialect, tableMap, from);
  return inSchema;
};

/*
 * Use explicit type if specified, otherwise try to
 * infer column type from expression.
 * Throws if type can not be inferred.
 */
const getOrInferColumnType = (
  dialect: SQLDialect,
  inSchema: Schema,
  colType: ColumnType | undefined,
  colExp: ColumnExtendExp
): ColumnType => {
  if (colType !== undefined) {
    return colType;
  }
  switch (colExp.expType) {
    case "ColRef":
      const colType = inSchema.columnType(colExp.colName);
      if (colType === undefined) {
        throw new Error(
          "Could not look up type information for column reference in extend expression: '" +
            colExp.colName +
            "'"
        );
      }
      return colType;
    case "AsString":
      return dialect.coreColumnTypes.string;
    case "ConstVal":
      switch (typeof colExp.val) {
        case "number":
          return dialect.coreColumnTypes.integer;
        case "string":
          return dialect.coreColumnTypes.string;
        case "boolean":
          return dialect.coreColumnTypes.boolean;
        default:
          throw new Error(
            "Could not infer column type for column extend expression: " +
              JSON.stringify(colExp)
          );
      }
    default:
      throw new Error(
        "Could not infer column type for column extend expression: " +
          JSON.stringify(colExp)
      );
  }
};

const extendGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { colId, colExp, opts, from }: ExtendQueryRep
): Schema => {
  const inSchema = getQuerySchema(dialect, tableMap, from);
  const colType = getOrInferColumnType(dialect, inSchema, opts.type, colExp);
  const displayName = opts.displayName != null ? opts.displayName : colId;
  return inSchema.extend(colId, { type: colType, displayName });
};

const joinGetSchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { rhs, on, joinType, lhs }: JoinQueryRep
): Schema => {
  if (joinType !== "LeftOuter") {
    throw new Error("unsupported join type: " + joinType);
  }

  const lhsSchema = getQuerySchema(dialect, tableMap, lhs);
  const rhsSchema = getQuerySchema(dialect, tableMap, rhs);

  const rhsCols = _.difference(
    rhsSchema.columns,
    _.concat(on, lhsSchema.columns)
  );

  const rhsMeta = _.pick(rhsSchema.columnMetadata, rhsCols);

  const joinCols = _.concat(lhsSchema.columns, rhsCols);

  const joinMeta = _.defaults(lhsSchema.columnMetadata, rhsMeta);

  const joinSchema = new Schema(joinCols, joinMeta);
  return joinSchema;
};

const getQuerySchema = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: QueryRep
): Schema => {
  switch (query.operator) {
    case "table":
      return tableGetSchema(dialect, tableMap, query);
    case "project":
      return projectGetSchema(dialect, tableMap, query);
    case "groupBy":
      return groupByGetSchema(dialect, tableMap, query);
    case "filter":
      return filterGetSchema(dialect, tableMap, query);
    case "mapColumns":
      return mapColumnsGetSchema(dialect, tableMap, query);
    case "mapColumnsByIndex":
      return mapColumnsByIndexGetSchema(dialect, tableMap, query);
    case "concat":
      return concatGetSchema(dialect, tableMap, query);
    case "sort":
      return filterGetSchema(dialect, tableMap, query);
    case "extend":
      return extendGetSchema(dialect, tableMap, query);
    case "join":
      return joinGetSchema(dialect, tableMap, query);
    default:
      const invalidQuery: never = query;
      throw new Error(
        "getQuerySchema: No implementation for operator, query: " + query
      );
  }
};

type GenSQLFunc = (tableMap: TableInfoMap, q: QueryExp) => SQLQueryAST;
type GenSQLMap = {
  [operator: string]: GenSQLFunc;
};

const tableQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { tableName }: TableQueryRep
): SQLQueryAST => {
  const schema = tableMap[tableName].schema;

  const selectCols = schema.columns;
  const sel = {
    selectCols: selectCols.map((cid) =>
      mkColSelItem(cid, schema.columnType(cid))
    ),
    from: tableName,
    groupBy: [],
    orderBy: [],
  };
  return {
    selectStmts: [sel],
  };
};

// Gather map by column id of SQLSelectListItem in a SQLSelectAST
const selectColsMap = (
  selExp: SQLSelectAST
): {
  [cid: string]: SQLSelectListItem;
} => {
  let ret: { [cid: string]: SQLSelectListItem } = {};

  for (let cexp of selExp.selectCols) {
    ret[getColId(cexp)] = cexp;
  }

  return ret;
};

const projectQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { cols, from }: ProjectQueryRep
): SQLQueryAST => {
  const sqsql = queryToSql(dialect, tableMap, from);

  // rewrite an individual select statement to only select projected cols:
  const rewriteSel = (sel: SQLSelectAST): SQLSelectAST => {
    const colsMap = selectColsMap(sel);
    const outCols = cols.map((cid: string) => {
      let outCol = colsMap[cid];

      if (outCol === undefined) {
        const sqStr = ppSQLQuery(defaultDialect, sqsql, -1, -1);
        throw new Error(
          "projectQueryToSql: no such column " +
            defaultDialect.quoteCol(cid) +
            " in subquery:  " +
            sqStr
        );
      }

      return outCol;
    });
    return _.defaults(
      {
        selectCols: outCols,
      },
      sel
    );
  };

  return {
    selectStmts: sqsql.selectStmts.map(rewriteSel),
  };
};

export const defaultAggFn = (ct: ColumnType): AggFn => ct.defaultAggFn;

const groupByQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { cols, aggs, from }: GroupByQueryRep
): SQLQueryAST => {
  const inSchema = getQuerySchema(dialect, tableMap, from);

  // emulate the uniq and null aggregation functions:
  const aggExprs: SQLSelectListItem[] = aggs.map((aggSpec) => {
    let aggStr: AggFn;
    let cid;
    let colExp: SQLValExp;

    let colType: ColumnType;
    if (typeof aggSpec === "string") {
      cid = aggSpec;
      colType = inSchema.columnType(cid);
      aggStr = defaultAggFn(colType);
    } else {
      [aggStr, cid] = aggSpec;
      colType = inSchema.columnType(cid);
    }

    if (aggStr == "null") {
      if (typeIsString(inSchema.columnType(cid))) {
        aggStr = "nullstr";
      }
    }

    return {
      colExp: { expType: "agg", aggFn: aggStr, exp: col(cid) },
      colType,
      as: cid,
    };
  });

  const selectGbCols: SQLSelectListItem[] = cols.map((cid) =>
    mkColSelItem(cid, inSchema.columnType(cid))
  );
  const selectCols = selectGbCols.concat(aggExprs);
  const sqsql = queryToSql(dialect, tableMap, from);

  // If sub-query is just a single select with no group by
  // and where every select expression a simple column id
  // we can rewrite it:

  let retSel: SQLSelectAST;
  const subSel = sqsql.selectStmts[0];

  if (
    sqsql.selectStmts.length === 1 &&
    _.every(
      subSel.selectCols,
      (sc) => typeof sc.colExp === "string" && sc.as === undefined
    ) &&
    subSel.where === undefined &&
    subSel.groupBy.length === 0 &&
    subSel.orderBy.length === 0
  ) {
    retSel = _.defaults(
      {
        selectCols,
        groupBy: cols,
      },
      subSel
    );
  } else {
    const from: SQLFromQuery = {
      expType: "query",
      query: sqsql,
    };
    retSel = {
      selectCols,
      from,
      groupBy: cols,
      orderBy: [],
    };
  }

  return {
    selectStmts: [retSel],
  };
};

const filterQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { fexp, from }: FilterQueryRep
): SQLQueryAST => {
  const sqsql = queryToSql(dialect, tableMap, from);

  const subSel = sqsql.selectStmts[0];
  let retSel: SQLSelectAST;
  if (
    sqsql.selectStmts.length === 1 &&
    subSel.where === undefined &&
    subSel.groupBy.length === 0
  ) {
    retSel = _.defaults(
      {
        where: fexp,
      },
      subSel
    );
  } else {
    const from: SQLFromQuery = {
      expType: "query",
      query: sqsql,
    };
    retSel = {
      selectCols: mkSubSelectList(subSel.selectCols),
      from,
      where: fexp,
      groupBy: [],
      orderBy: [],
    };
  }

  return {
    selectStmts: [retSel],
  };
};

/*
 * Note: this implements both mapColumns and mapColumsByIndex
 * Regrettably, we can't easily give this a generic type in TypeScript because
 * generic type params for map-like objects not yet supported,
 * see: https://github.com/microsoft/TypeScript/issues/12754
 * We'll just give cmap an 'any' type, grieve briefly, and move on.
 */
type MapColumnsGenQueryRep<T extends Object> = { cmap: any; from: QueryRep };
function mapColumnsQueryToSql<T extends Object>(
  dialect: SQLDialect,
  byIndex: boolean,
  tableMap: TableInfoMap,
  { cmap, from }: MapColumnsGenQueryRep<T>
): SQLQueryAST {
  const sqsql = queryToSql(dialect, tableMap, from); // apply renaming to invididual select expression:

  const applyColRename = (
    cexp: SQLSelectListItem,
    index: number
  ): SQLSelectListItem => {
    const inCid = getColId(cexp);
    const mapKey = byIndex ? index : inCid;
    const outCid = cmap.hasOwnProperty(mapKey) ? cmap[mapKey].id : inCid;

    return {
      colExp: cexp.colExp,
      colType: cexp.colType,
      as: outCid,
    };
  };

  // rewrite an individual select statement by applying rename mapping:
  const rewriteSel = (sel: SQLSelectAST): SQLSelectAST => {
    const selectCols = sel.selectCols.map(applyColRename);
    return _.defaults(
      {
        selectCols,
      },
      sel
    );
  };

  const ret = {
    selectStmts: sqsql.selectStmts.map(rewriteSel),
  };
  return ret;
}

const concatQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { target, from }: ConcatQueryRep
): SQLQueryAST => {
  const sqSqls = [
    queryToSql(dialect, tableMap, from),
    queryToSql(dialect, tableMap, target),
  ];
  const allSelStmts = sqSqls.map((q) => q.selectStmts);
  return {
    selectStmts: _.flatten(allSelStmts),
  };
};

const sortQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { keys, from }: SortQueryRep
): SQLQueryAST => {
  const sqsql = queryToSql(dialect, tableMap, from);
  const orderBy = keys.map(([col, asc]) => ({
    col,
    asc,
  }));

  // If subquery just a single select with no orderBy clause, just add one:
  const subSel = sqsql.selectStmts[0];
  let retSel: SQLSelectAST;

  if (sqsql.selectStmts.length === 1 && subSel.orderBy.length === 0) {
    retSel = _.defaults(
      {
        orderBy,
      },
      subSel
    );
  } else {
    const from: SQLFromQuery = {
      expType: "query",
      query: sqsql,
    };
    retSel = {
      selectCols: mkSubSelectList(subSel.selectCols),
      from,
      groupBy: [],
      orderBy,
    };
  }

  return {
    selectStmts: [retSel],
  };
};

/*
const intRE = /^[-+]?[$]?[0-9,]+$/
const strLitRE = /^'[^']*'$/
const nullRE = /^null$/
*/

const litRE = /^[-+]?[$]?[0-9,]+$|^'[^']*'$|^null$/;
/*
 * determine if extend expression is a constant expression, so that
 * we can inline the extend expression.
 *
 * Conservative approximation -- true => constant expr, but false may or may not be constant
 *
 * Only returns true for simple literal exprs for now; should expand to handle binary ops
 */

const isConstantExpr = (expr: string): boolean => {
  const ret = litRE.test(expr);
  /*
    const selExp = `select (${expr})`
    const selPtree = sqliteParser(selExp)
    const expPtree = selPtree.statement[0].result[0]
    const ret = (expPtree.type === 'literal')
  */

  return ret;
};

const extendQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  { colId, opts, colExp, from }: ExtendQueryRep
): SQLQueryAST => {
  const inSchema = getQuerySchema(dialect, tableMap, from);
  const colType = getOrInferColumnType(dialect, inSchema, opts.type, colExp);
  const sqsql = queryToSql(dialect, tableMap, from);
  const subSel = sqsql.selectStmts[0];

  // Note: We only want to extract the column ids from subquery for use at this level; we
  // want to skip any calculated expressions or aggregate functions

  const isConst = colExp.expType === "ConstVal";
  let retSel: SQLSelectAST;

  if (isConst && sqsql.selectStmts.length === 1) {
    // just append our column to existing selectCols list:
    const outSel = subSel.selectCols.slice();
    outSel.push({
      colExp,
      colType,
      as: colId,
    });
    retSel = _.defaults(
      {
        selectCols: outSel,
      },
      subSel
    );
  } else {
    let selectCols: SQLSelectListItem[] = mkSubSelectList(subSel.selectCols);
    selectCols.push({
      colExp,
      colType,
      as: colId,
    });
    const from: SQLFromQuery = {
      expType: "query",
      query: sqsql,
    };
    retSel = {
      selectCols,
      from,
      groupBy: [],
      orderBy: [],
    };
  }

  return {
    selectStmts: [retSel],
  };
};

const joinQueryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: JoinQueryRep
): SQLQueryAST => {
  const { lhs, rhs, on: onArg, joinType } = query;
  const lhsSql = queryToSql(dialect, tableMap, lhs);
  const rhsSql = queryToSql(dialect, tableMap, rhs);
  const outSchema = getQuerySchema(dialect, tableMap, query);

  const selectCols: SQLSelectListItem[] = outSchema.columns.map((cid) =>
    mkColSelItem(cid, outSchema.columnType(cid))
  );
  const from: SQLFromJoin = {
    expType: "join",
    joinType,
    lhs: lhsSql,
    rhs: rhsSql,
  };
  const on = typeof onArg === "string" ? [onArg] : onArg;
  const retSel: SQLSelectAST = {
    selectCols,
    from,
    on,
    groupBy: [],
    orderBy: [],
  };
  return {
    selectStmts: [retSel],
  };
};

const queryToSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: QueryRep
): SQLQueryAST => {
  switch (query.operator) {
    case "table":
      return tableQueryToSql(dialect, tableMap, query);
    case "project":
      return projectQueryToSql(dialect, tableMap, query);
    case "groupBy":
      return groupByQueryToSql(dialect, tableMap, query);
    case "filter":
      return filterQueryToSql(dialect, tableMap, query);
    case "mapColumns":
      return mapColumnsQueryToSql(dialect, false, tableMap, query);
    case "mapColumnsByIndex":
      return mapColumnsQueryToSql(dialect, true, tableMap, query);
    case "concat":
      return concatQueryToSql(dialect, tableMap, query);
    case "sort":
      return sortQueryToSql(dialect, tableMap, query);
    case "extend":
      return extendQueryToSql(dialect, tableMap, query);
    case "join":
      return joinQueryToSql(dialect, tableMap, query);
    default:
      const invalidQuery: never = query;
      throw new Error("queryToSql: No implementation for operator: " + query);
  }
};

// Generate a count(*) as rowCount wrapper around a query:
const queryToCountSql = (
  dialect: SQLDialect,
  tableMap: TableInfoMap,
  query: QueryRep
): SQLQueryAST => {
  const sqsql = queryToSql(dialect, tableMap, query);
  const colExp = mkAggExp("count", constVal("*"));
  const as = "rowCount";
  const selectCols: SQLSelectListItem[] = [
    {
      colExp,
      colType: dialect.coreColumnTypes.integer,
      as,
    },
  ];
  const from: SQLFromQuery = {
    expType: "query",
    query: sqsql,
  };
  const retSel: SQLSelectAST = {
    selectCols,
    from,
    groupBy: [],
    orderBy: [],
  };
  return {
    selectStmts: [retSel],
  };
};

// Create base of a query expression chain by starting with "table":

export const tableQuery = (tableName: string): QueryExp => {
  return new QueryExp({ operator: "table", tableName });
};
