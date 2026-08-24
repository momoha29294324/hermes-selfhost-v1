import { Fragment } from 'react';
import Link from 'next/link';
import {
  loadCrmInbox,
  loadCrmInboxStatus,
  type CrmInboxRow,
  type CrmInboxStatus,
} from '@/lib/crm/queries';
import { formatDateTime, formatDateTimeShort } from '@/lib/crm/view';
import { CrmUnavailable } from '@/app/crm/unavailable';
import { RowNav } from '@/app/crm/row-nav';
import { Avatar, Card, EmptyState, TermBadge } from '@/app/crm/ui';
import {
  correlationTerm,
  draftStatusTerm,
  nextActionTerm,
  replyCategoryTerm,
} from '@/lib/crm/vocabulary';

export const dynamic = 'force-dynamic';

/**
 * Les réponses entrantes.
 *
 * Coquille minimale, et volontairement : `r6b_inbound_messages` ne contient
 * aujourd'hui aucune ligne. La page dit donc ce qui est vrai — un envoi parti,
 * aucune réponse reçue — plutôt que d'afficher un faux fil de conversation.
 *
 * Aucun composeur, aucun bouton de réponse : le seul chemin d'envoi de ce dépôt
 * est le dispatcher R6B, hors interface (AGENTS.md §1).
 */
export default async function CrmInboxPage() {
  let rows: CrmInboxRow[];
  let status: CrmInboxStatus;
  try {
    [rows, status] = await Promise.all([loadCrmInbox(), loadCrmInboxStatus()]);
  } catch (error) {
    return <CrmUnavailable error={error} />;
  }

  return (
    <>
      <div className="crm-head">
        <div className="crm-head-titles">
          <h1>Inbox</h1>
          <div className="sub">{rows.length} réponse(s) entrante(s)</div>
        </div>
        <span className="crm-meta" style={{ marginLeft: 'auto' }}>
          lecture seule — aucune réponse ne part d’ici
        </span>
      </div>

      <div className="crm-body">
        {rows.length === 0 ? (
          <Empty status={status} />
        ) : (
          <>
            <RowNav />
            <div className="crm-panelcard">
              <table className="crm-table fixed">
                <colgroup>
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '40%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '21%' }} />
                  <col style={{ width: '14%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Reçu</th>
                    <th>Message</th>
                    <th>Compris comme</th>
                    <th>Prochaine action</th>
                    <th>Brouillon</th>
                  </tr>
                </thead>
                <tbody>
                  {groupByConversation(rows).map((group) => (
                    <Fragment key={group.key}>
                      <ConversationHead group={group} />
                      {group.rows.map((row) => (
                        <InboxRow key={row.id} row={row} />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Le regroupement par CONVERSATION.
 *
 * Vingt-trois réponses, mais quatre correspondants : la colonne « Entreprise »
 * réécrivait « Northstar Studio » seize fois de suite, et l'œil ne pouvait pas
 * voir où un fil commençait et où le suivant reprenait. Le regroupement ne
 * réordonne RIEN — les lignes restent dans l'ordre de `loadCrmInbox`, du plus
 * récent au plus ancien — et n'agrège aucune valeur : il insère une rangée de
 * titre quand le correspondant change, c'est tout.
 *
 * La clé est le prospect quand il est corrélé, et l'adresse d'expédition
 * sinon : deux messages non corrélés venant de deux comptes différents ne
 * doivent pas se retrouver sous le même titre.
 */
interface Conversation {
  readonly key: string;
  readonly subject: string;
  readonly rows: CrmInboxRow[];
}

function groupByConversation(rows: readonly CrmInboxRow[]): Conversation[] {
  const groups: Conversation[] = [];
  for (const row of rows) {
    const subject = row.prospectId ?? `from:${row.fromAddress}`;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.subject === subject) {
      last.rows.push(row);
      continue;
    }
    // La clé porte le RANG du groupe : l'ordre reste chronologique, donc un
    // même correspondant peut ouvrir deux groupes séparés par un autre.
    groups.push({ key: `${subject}#${groups.length}`, subject, rows: [row] });
  }
  return groups;
}

/**
 * Le titre d'un fil. Il ne porte que ce que ses lignes portent déjà : le nom,
 * le canal, le compte, et le NOMBRE de messages — un `length`, pas un calcul.
 */
function ConversationHead({ group }: { group: Conversation }) {
  const [first] = group.rows;
  if (first === undefined) return null;
  const waiting = group.rows.some((row) => row.nextAction !== null);
  return (
    <tr className="crm-grouprow">
      <td colSpan={5}>
        <div className="crm-grouphead" data-tone={waiting ? 'orange' : 'slate'}>
          <Avatar name={first.company ?? '?'} tone={waiting ? 'orange' : 'slate'} />
          {first.prospectId === null ? (
            <span className="nm crm-dim">non corrélé</span>
          ) : (
            <Link className="nm" href={`/crm/prospects/${first.prospectId}`} prefetch={false}>
              {first.company}
            </Link>
          )}
          <span className="mt">
            {first.provider === 'instagram' ? 'Instagram' : 'Email'} · {first.fromAddress}
          </span>
          <span className="ct">
            {group.rows.length} message{group.rows.length > 1 ? 's' : ''}
          </span>
        </div>
      </td>
    </tr>
  );
}

/**
 * Une réponse entrante — et la seule hiérarchie qui compte ici.
 *
 * ---------------------------------------------------------------------------
 * Ce que cette ligne disait de travers
 * ---------------------------------------------------------------------------
 *
 * CRM2 rendait `EXACT` en pastille verte pleine sur CHAQUE ligne. C'est un
 * détail de corrélation technique, il vaut `EXACT` presque toujours, et il
 * dominait la colonne « Action » — rendue en gris pâle à l'extrémité droite —
 * qui est la seule chose qu'un opérateur ait à lire. La couleur disait donc
 * « tout va bien » là où l'écran aurait dû dire « quelqu'un attend ».
 *
 * La corrélation descend au palier 4 quand elle est exacte, et remonte d'elle
 * même dès qu'elle s'en écarte (`vocabulary.ts`) : on ne voit plus que
 * l'anormal. L'action recommandée passe au palier 1.
 *
 * ---------------------------------------------------------------------------
 * Et ce qu'elle ne disait pas du tout
 * ---------------------------------------------------------------------------
 *
 * Le TEXTE du message. `loadCrmInbox` lit pourtant `left(body_text, 240)`
 * depuis toujours ; la colonne n'existait simplement pas, si bien qu'une boîte
 * de vingt-trois réponses ne permettait pas de savoir ce qu'une seule disait.
 * C'est la seule colonne qui a le droit de manger sa largeur, et elle reste sur
 * une ligne — un retour à la ligne détruirait le rythme de balayage.
 */
function InboxRow({ row }: { row: CrmInboxRow }) {
  const classification = replyCategoryTerm(row.classification);
  const action = nextActionTerm(row.nextAction);
  const draft = draftStatusTerm(row.draftStatus);
  const correlation = correlationTerm(row.correlationStatus);
  const excerpt = row.excerpt.trim();

  return (
    <tr
      data-wait={action === null ? 'no' : 'yes'}
      {...(row.prospectId === null ? {} : { 'data-href': `/crm/prospects/${row.prospectId}` })}
    >
      <td className="crm-mono crm-dim" title={formatDateTime(row.receivedAt)}>
        {formatDateTimeShort(row.receivedAt)}
      </td>

      {/*
        Le NOM de l'entreprise ne se répète plus ligne à ligne : la rangée de
        titre du fil le porte une fois, avec son canal et son compte. Ce qui
        reste ici est ce qu'un titre de fil ne peut PAS dire, parce que c'est
        vrai d'un message et non d'une conversation : la corrélation. Exacte —
        le cas normal — elle ne s'écrit pas ; tout écart s'écrit en toutes
        lettres, devant le texte, là où on ne peut pas le manquer.

        La colonne libérée va au MESSAGE, qui passe de 30 % à 40 % de la
        largeur : c'est la seule colonne dont la troncature coûte quelque chose.
      */}
      <td>
        {excerpt.length === 0 ? (
          <span className="crm-dim">—</span>
        ) : (
          <span className="crm-quote-line" title={excerpt}>
            {correlation === null || correlation.raw === 'EXACT' ? null : (
              <>
                <b data-tone={correlation.tone} className="crm-flag" title={correlation.raw}>
                  {correlation.label}
                </b>{' '}
              </>
            )}
            {row.subject === null ? null : <b>{row.subject} — </b>}
            {excerpt}
          </span>
        )}
      </td>

      <td>
        {classification === null ? (
          <span className="crm-dim">—</span>
        ) : (
          <span className="crm-stack">
            {/* Palier 3 : ce que le classifieur a compris APPUIE la décision,
                il ne la remplace pas — la colonne d'action la porte déjà. */}
            <TermBadge term={classification} tier={3} />
            {row.confidence === null ? null : (
              <span className="crm-raw" title="confiance du classifieur">
                {row.confidence.toFixed(2)}
              </span>
            )}
          </span>
        )}
      </td>

      <td>
        {action === null ? (
          <span className="crm-dim">—</span>
        ) : (
          /* Rabaissé d'un cran : sur CETTE page, « répondre maintenant » est le
             cas ordinaire. Vingt paliers 1 à la suite ne font pas vingt
             urgences, ils font un écran orange. Dans la liste des prospects, où
             l'action est l'exception, le palier intrinsèque s'applique. */
          <TermBadge term={action} icon="target" tier={action.tier === 1 ? 2 : action.tier} />
        )}
      </td>

      <td>{draft === null ? <span className="crm-dim">—</span> : <TermBadge term={draft} tier={3} />}</td>
    </tr>
  );
}

/**
 * L'état vide, en faits observés seulement.
 *
 * CRM1 affichait ici deux commandes `npm run` : une instruction d'opérateur
 * dans une interface produit, c'est-à-dire l'aveu que la page ne sait pas dire
 * ce qui se passe. Elle le sait pourtant — `r6b_inbound_checkpoints` porte la
 * date du dernier tour de relève abouti, et `outreach_events` le nombre de
 * prospects réellement contactés.
 *
 * Ce qui n'est PAS affiché compte autant : aucune « prochaine relève », aucun
 * délai, aucune fréquence. Ce dépôt ne contient aucun ordonnanceur — la relève
 * est déclenchée à la main, hors interface — et annoncer un horaire serait
 * inventer un état produit (AGENTS.md §2).
 */
function Empty({ status }: { status: CrmInboxStatus }) {
  const polled = status.mailbox !== null && status.lastPolledAt !== null;
  return (
    <div style={{ maxWidth: 560 }}>
      <EmptyState icon="inbox" title="Aucune réponse">
        Seuls les messages liés à un envoi sortant de ce dépôt sont conservés. Rien d’autre de la
        boîte n’est lu ni stocké.
      </EmptyState>

      <Card icon="clock" title="Ce que le poller a réellement vu" tone="slate">
        <dl className="crm-kv">
          <div className="r">
            <dt>Boîte</dt>
            <dd className={polled ? 'crm-mono' : ''}>
              {polled ? status.mailbox : <span className="crm-dim">aucune relève enregistrée</span>}
            </dd>
          </div>
          <div className="r">
            <dt>Dernière relève</dt>
            <dd>{polled ? formatDateTime(status.lastPolledAt) : <span className="crm-dim">—</span>}</dd>
          </div>
          <div className="r">
            <dt>Compte Instagram</dt>
            <dd className={status.instagramAccount === null ? '' : 'crm-mono'}>
              {status.instagramAccount === null ? (
                <span className="crm-dim">aucune relève enregistrée</span>
              ) : (
                `@${status.instagramAccount}`
              )}
            </dd>
          </div>
          <div className="r">
            <dt>Dernière relève Instagram</dt>
            <dd>
              {status.instagramLastPolledAt === null ? (
                <span className="crm-dim">—</span>
              ) : (
                formatDateTime(status.instagramLastPolledAt)
              )}
            </dd>
          </div>
          <div className="r">
            <dt>Contactés</dt>
            <dd>
              {status.contactedProspects} prospect{status.contactedProspects > 1 ? 's' : ''}
            </dd>
          </div>
          <div className="r">
            <dt>Réponses</dt>
            <dd>{status.replies}</dd>
          </div>
          {status.invalidationCount > 0 ? (
            <div className="r">
              <dt>Curseur</dt>
              <dd>{status.invalidationCount} invalidation(s) — resynchronisation bornée</dd>
            </div>
          ) : null}
        </dl>
        <p className="crm-prose" style={{ fontSize: 11, marginTop: 10 }}>
          La relève est déclenchée hors interface ; aucune n’est planifiée.
        </p>
      </Card>
    </div>
  );
}
