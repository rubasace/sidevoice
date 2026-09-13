import unittest
from thread_monitor import relevant_event, unpack_poll

class MonitorTests(unittest.TestCase):
    def test_technical_commentary_is_not_spoken(self):
        self.assertIsNone(relevant_event({'latestAssistantMessage':{'id':'a','phase':'commentary','text':'running rg'},'latestTurn':{'status':'inProgress'}}))

    def test_final_and_attention_are_relevant(self):
        e=relevant_event({'latestAssistantMessage':{'id':'a','phase':'final_answer','text':'Archivo listo'},'latestTurn':{'status':'completed'}})
        self.assertEqual(e['kind'],'result')
        e=relevant_event({'latestTurn':{'id':'b','status':'failed','error':{'message':'failed'}}})
        self.assertEqual(e['kind'],'attention')

    def test_failed_tool_response_is_not_a_worker_result(self):
        self.assertIsNone(unpack_poll({'result':{'success':False,'contentItems':[]}}))

    def test_old_final_does_not_hide_failure_or_announce_during_new_turn(self):
        old = {'id':'old', 'phase':'final_answer', 'text':'Finished earlier'}
        self.assertIsNone(relevant_event({'latestAssistantMessage':old,'latestTurn':{'id':'new','status':'inProgress'}}))
        self.assertEqual(relevant_event({'latestAssistantMessage':old,'latestTurn':{'id':'new','status':'failed'}})['kind'],'attention')
        old['turnId'] = 'old-turn'
        self.assertIsNone(relevant_event({'latestAssistantMessage':old,'latestTurn':{'id':'new','status':'completed'}}))
